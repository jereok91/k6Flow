package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"k6flow/apps/orchestrator/internal/config"
)

// Label, script-delivery and limit constants shared with tests and callers.
const (
	// LabelManaged marks every container k6flow creates; Create forces "true".
	LabelManaged = "k6flow.managed"
	// LabelRunID carries the run id label; callers set it via Spec.Labels
	// and Create passes it through unchanged.
	LabelRunID = "k6flow.run.id"
	// ScriptEnvKey reserves the script content inside Spec.Env: Create strips
	// it before ContainerCreate, delivers the bytes as an in-memory tar and
	// never passes them to the container environment or the logs.
	ScriptEnvKey = "K6FLOW_SCRIPT"
	// ScriptPath is the fixed in-container script destination; the run command
	// references it (e.g. "run /k6flow/script.js").
	ScriptPath = "/k6flow/script.js"
)

// dockerAPI is exactly the subset of the official Docker SDK client that
// DockerRuntime uses, so unit tests can fake it without opening a socket.
type dockerAPI interface {
	ContainerCreate(ctx context.Context, cfg *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
	ContainerList(ctx context.Context, options container.ListOptions) ([]container.Summary, error)
	ContainerLogs(ctx context.Context, containerID string, options container.LogsOptions) (io.ReadCloser, error)
	CopyToContainer(ctx context.Context, containerID, dstPath string, content io.Reader, options container.CopyToContainerOptions) error
}

// Compile-time conformance: DockerRuntime satisfies ContainerRuntime. The
// dockerAPI signatures are transcribed verbatim from github.com/docker/docker
// client v28.5.2; asserting *client.Client satisfies this interface here would
// import the client's OpenTelemetry tree and force a go directive beyond the
// frozen golang:1.25.7 build image, so conformance is proven by the real-engine
// unit (K6F2-05) instead.
var _ ContainerRuntime = (*DockerRuntime)(nil)

// DockerRuntime implements ContainerRuntime over the official Docker SDK.
// It logs lifecycle metadata only (container id, image, exit code, counts) —
// never script or environment values. Cleanup and ReconcileOrphans guarantee
// removal; the embedded Semaphore bounds concurrent runs.
type DockerRuntime struct {
	api         dockerAPI
	image       string
	log         *slog.Logger
	sem         *Semaphore
	stopTimeout time.Duration
}

// NewDockerRuntime builds a DockerRuntime from the injected SDK client and
// orchestrator config. logger may be nil (slog.Default is used). The semaphore
// is sized by cfg.MaxConcurrentRuns; stopTimeout (RUN_TIMEOUT_MS) is the
// graceful period Cleanup uses before forcing removal.
func NewDockerRuntime(api dockerAPI, cfg config.Config, logger *slog.Logger) *DockerRuntime {
	if logger == nil {
		logger = slog.Default()
	}
	return &DockerRuntime{
		api:         api,
		image:       cfg.K6Image,
		log:         logger,
		sem:         NewSemaphore(cfg.MaxConcurrentRuns),
		stopTimeout: time.Duration(cfg.RunTimeoutMS) * time.Millisecond,
	}
}

const (
	nanoPerMilli = 1_000_000 // 1 CPU = 1e9 NanoCPUs, so 1 cpu-millis = 1e6
	bytesPerMiB  = 1 << 20
)

// cpuNanoCPUs converts Spec.CPUMillis to Docker NanoCPUs with a range guard:
// values that would overflow int64 (including the contract's 2^53-1 ceiling)
// are rejected instead of silently wrapping.
func cpuNanoCPUs(cpuMillis int) (int64, error) {
	if cpuMillis <= 0 {
		return 0, fmt.Errorf("runtime: cpuMillis must be positive, got %d", cpuMillis)
	}
	if int64(cpuMillis) > math.MaxInt64/nanoPerMilli {
		return 0, fmt.Errorf("runtime: cpuMillis %d exceeds the docker NanoCPUs range", cpuMillis)
	}
	return int64(cpuMillis) * nanoPerMilli, nil
}

// memoryBytes converts Spec.MemoryMiB to bytes with the same overflow guard.
func memoryBytes(memoryMiB int) (int64, error) {
	if memoryMiB <= 0 {
		return 0, fmt.Errorf("runtime: memoryMiB must be positive, got %d", memoryMiB)
	}
	if int64(memoryMiB) > math.MaxInt64/bytesPerMiB {
		return 0, fmt.Errorf("runtime: memoryMiB %d exceeds the docker memory range", memoryMiB)
	}
	return int64(memoryMiB) * bytesPerMiB, nil
}

// splitScriptEnv extracts the reserved script key and returns the remaining
// container environment; the script never reaches ContainerCreate.
func splitScriptEnv(env map[string]string) ([]byte, map[string]string) {
	rest := make(map[string]string, len(env))
	var script []byte
	for key, value := range env {
		if key == ScriptEnvKey {
			script = []byte(value)
			continue
		}
		rest[key] = value
	}
	return script, rest
}

// sortedEnv renders the environment deterministically as sorted K=V entries.
func sortedEnv(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

// deliverScript streams the script into the container as an in-memory tar:
// no host file is ever created, so script bytes exist only inside the
// container filesystem and vanish with the container's removal.
func (d *DockerRuntime) deliverScript(ctx context.Context, containerID string, script []byte) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	dir := strings.TrimPrefix(path.Dir(ScriptPath), "/")
	name := strings.TrimPrefix(ScriptPath, "/")
	if err := tw.WriteHeader(&tar.Header{Name: dir + "/", Mode: 0o755, Typeflag: tar.TypeDir}); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(script)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(script); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return d.api.CopyToContainer(ctx, containerID, "/", &buf, container.CopyToContainerOptions{})
}

// Create creates one labeled container per run: forced k6flow.managed=true,
// run-id label passthrough, CPU/memory limits, controlled network
// (Spec.Network empty ⇒ engine default), image from Spec with config
// fallback, and the script delivered in-memory with the reserved ScriptEnvKey
// stripped from the container env. A failed script delivery removes the
// half-created container before returning.
func (d *DockerRuntime) Create(ctx context.Context, spec Spec) (string, error) {
	image := spec.Image
	if image == "" {
		image = d.image
	}
	if image == "" {
		return "", errors.New("runtime: no container image configured")
	}
	nanoCPUs, err := cpuNanoCPUs(spec.CPUMillis)
	if err != nil {
		return "", err
	}
	memory, err := memoryBytes(spec.MemoryMiB)
	if err != nil {
		return "", err
	}
	labels := make(map[string]string, len(spec.Labels)+1)
	for key, value := range spec.Labels {
		labels[key] = value
	}
	labels[LabelManaged] = "true"
	script, env := splitScriptEnv(spec.Env)
	cfg := &container.Config{
		Image:  image,
		Cmd:    append(append([]string(nil), spec.Command...), spec.Args...),
		Env:    sortedEnv(env),
		Labels: labels,
	}
	host := &container.HostConfig{
		Resources:   container.Resources{NanoCPUs: nanoCPUs, Memory: memory},
		NetworkMode: container.NetworkMode(spec.Network),
	}
	resp, err := d.api.ContainerCreate(ctx, cfg, host, &network.NetworkingConfig{}, nil, "")
	if err != nil {
		return "", fmt.Errorf("runtime: create: %w", err)
	}
	d.log.Info("container created", "container", resp.ID, "image", image)
	if len(script) == 0 {
		return resp.ID, nil
	}
	if err := d.deliverScript(ctx, resp.ID, script); err != nil {
		d.log.Warn("script delivery failed", "container", resp.ID, "error", err)
		// Guaranteed removal: a half-created container must not linger even
		// when the caller's context is already canceled.
		removeErr := d.Remove(context.WithoutCancel(ctx), resp.ID, true)
		if removeErr != nil {
			d.log.Warn("cleanup remove failed", "container", resp.ID, "error", removeErr)
		}
		return "", errors.Join(fmt.Errorf("runtime: deliver script: %w", err), removeErr)
	}
	return resp.ID, nil
}

// Start starts the container.
func (d *DockerRuntime) Start(ctx context.Context, containerID string) error {
	if err := d.api.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("runtime: start %s: %w", containerID, err)
	}
	d.log.Info("container started", "container", containerID)
	return nil
}

// Wait blocks until the container is not running and reports its exit code.
func (d *DockerRuntime) Wait(ctx context.Context, containerID string) (int, error) {
	statusCh, errCh := d.api.ContainerWait(ctx, containerID, container.WaitConditionNotRunning)
	select {
	case status := <-statusCh:
		if status.Error != nil {
			return 0, fmt.Errorf("runtime: wait %s: %s", containerID, status.Error.Message)
		}
		code := int(status.StatusCode)
		d.log.Info("container exited", "container", containerID, "exit_code", code)
		return code, nil
	case err := <-errCh:
		if err == nil {
			err = errors.New("wait ended without a status")
		}
		return 0, fmt.Errorf("runtime: wait %s: %w", containerID, err)
	case <-ctx.Done():
		return 0, fmt.Errorf("runtime: wait %s: %w", containerID, ctx.Err())
	}
}

// Stop asks the container to stop gracefully, rounding timeout up to whole
// seconds so the grace period is never shorter than requested; a nonpositive
// timeout leaves the engine default (10s).
func (d *DockerRuntime) Stop(ctx context.Context, containerID string, timeout time.Duration) error {
	opts := container.StopOptions{}
	if timeout > 0 {
		seconds := int((timeout + time.Second - 1) / time.Second)
		opts.Timeout = &seconds
	}
	if err := d.api.ContainerStop(ctx, containerID, opts); err != nil {
		return fmt.Errorf("runtime: stop %s: %w", containerID, err)
	}
	d.log.Info("container stopped", "container", containerID)
	return nil
}

// Remove removes the container; callers on finish/fail/stop/cancel paths pass
// force=true as the fallback that still succeeds on running containers.
func (d *DockerRuntime) Remove(ctx context.Context, containerID string, force bool) error {
	if err := d.api.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: force}); err != nil {
		return fmt.Errorf("runtime: remove %s: %w", containerID, err)
	}
	d.log.Info("container removed", "container", containerID, "force", force)
	return nil
}

// Output returns the container's log stream (stdout+stderr, following) as the
// attachment point for the K6F2-04 JSON parser; the caller owns Close. The
// raw Docker stream, including multiplex headers when the container has no
// TTY, is demultiplexed by the consumer, not here.
func (d *DockerRuntime) Output(ctx context.Context, containerID string) (io.ReadCloser, error) {
	reader, err := d.api.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
	})
	if err != nil {
		return nil, fmt.Errorf("runtime: output %s: %w", containerID, err)
	}
	d.log.Info("log stream attached", "container", containerID)
	return reader, nil
}

// ListLabeled returns the ids of every container labeled k6flow.managed=true,
// including stopped ones (All) — the orphan-reconciliation query.
func (d *DockerRuntime) ListLabeled(ctx context.Context) ([]string, error) {
	summaries, err := d.api.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", LabelManaged+"=true")),
	})
	if err != nil {
		return nil, fmt.Errorf("runtime: list managed containers: %w", err)
	}
	ids := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		ids = append(ids, summary.ID)
	}
	return ids, nil
}

// Cleanup guarantees removal on every path: graceful Stop with the configured
// timeout, then Remove with force as fallback. Remove is always attempted —
// even when Stop fails or ctx is already canceled (context.WithoutCancel) —
// and Cleanup never returns before that attempt.
func (d *DockerRuntime) Cleanup(ctx context.Context, containerID string) error {
	stopErr := d.Stop(ctx, containerID, d.stopTimeout)
	if stopErr != nil {
		d.log.Warn("stop failed during cleanup", "container", containerID, "error", stopErr)
	}
	removeErr := d.Remove(context.WithoutCancel(ctx), containerID, true)
	if removeErr != nil {
		d.log.Warn("remove failed during cleanup", "container", containerID, "error", removeErr)
	}
	return errors.Join(stopErr, removeErr)
}

// ReconcileOrphans removes every k6flow-managed container left behind by a
// previous orchestrator process and reports how many were removed. It is
// documented to run at startup; wiring to cmd/server happens in a later unit.
// A list error is returned; individual removal failures are tolerated and
// logged as warnings so one stuck container cannot block reconciliation.
func (d *DockerRuntime) ReconcileOrphans(ctx context.Context) (int, error) {
	ids, err := d.ListLabeled(ctx)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, id := range ids {
		if err := d.Remove(ctx, id, true); err != nil {
			d.log.Warn("orphan removal failed", "container", id, "error", err)
			continue
		}
		removed++
	}
	d.log.Info("orphan reconciliation finished", "listed", len(ids), "removed", removed)
	return removed, nil
}

// Semaphore bounds concurrent runs. Acquisition is context-aware: Acquire
// blocks until a slot frees or ctx is done. Handler-level enforcement is
// wired in a later unit.
type Semaphore struct {
	ch chan struct{}
}

// NewSemaphore returns a semaphore with n slots; n < 1 is clamped to one slot.
func NewSemaphore(n int) *Semaphore {
	if n < 1 {
		n = 1
	}
	return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire takes a slot or returns ctx's error when the context is done.
func (s *Semaphore) Acquire(ctx context.Context) error {
	select {
	case s.ch <- struct{}{}:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("runtime: semaphore acquire: %w", ctx.Err())
	}
}

// Release frees a slot; releasing an empty semaphore is a no-op, so a double
// release can never deadlock the pool.
func (s *Semaphore) Release() {
	select {
	case <-s.ch:
	default:
	}
}

// Acquire takes a run slot from the semaphore sized by MAX_CONCURRENT_RUNS.
// Enforcement at the request handlers is deferred to a later unit.
func (d *DockerRuntime) Acquire(ctx context.Context) error {
	return d.sem.Acquire(ctx)
}

// Release frees a run slot; see Semaphore.Release.
func (d *DockerRuntime) Release() {
	d.sem.Release()
}
