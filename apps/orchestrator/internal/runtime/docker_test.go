package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"k6flow/apps/orchestrator/internal/config"
)

// fakeDockerAPI implements the dockerAPI subset with a call-order log,
// scripted results and per-operation error injection; it never opens a socket.
type fakeDockerAPI struct {
	mu    sync.Mutex
	calls []string

	createdID string
	createErr error
	cfg       *container.Config
	host      *container.HostConfig
	netConf   *network.NetworkingConfig
	platform  *ocispec.Platform
	name      string

	startErr error

	waitErr      error
	waitResp     container.WaitResponse
	waitBlock    bool
	waitCondUsed container.WaitCondition

	stopErr      error
	stopOpts     container.StopOptions
	stopCtxErr   error
	removeErr    error
	removeErrs   map[string]error
	removeForces map[string]bool
	removeCtxErr error

	listErr  error
	listed   []container.Summary
	listOpts container.ListOptions

	logsErr    error
	logsReader io.ReadCloser
	logsOpts   container.LogsOptions

	copyErr   error
	copyCount int
	copyDst   string
	copyTar   []byte
}

func (f *fakeDockerAPI) ContainerCreate(_ context.Context, cfg *container.Config, host *container.HostConfig, netConf *network.NetworkingConfig, platform *ocispec.Platform, name string) (container.CreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Create")
	f.cfg, f.host, f.netConf, f.platform, f.name = cfg, host, netConf, platform, name
	if f.createErr != nil {
		return container.CreateResponse{}, f.createErr
	}
	return container.CreateResponse{ID: f.createdID}, nil
}

func (f *fakeDockerAPI) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Start:"+id)
	return f.startErr
}

func (f *fakeDockerAPI) ContainerWait(_ context.Context, id string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Wait:"+id)
	f.waitCondUsed = condition
	status := make(chan container.WaitResponse, 1)
	errs := make(chan error, 1)
	switch {
	case f.waitBlock: // deliver nothing: Wait must fall back to ctx
	case f.waitErr != nil:
		errs <- f.waitErr
	default:
		status <- f.waitResp
	}
	return status, errs
}

func (f *fakeDockerAPI) ContainerStop(ctx context.Context, id string, opts container.StopOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Stop:"+id)
	f.stopOpts = opts
	f.stopCtxErr = ctx.Err()
	if f.stopErr != nil {
		return f.stopErr
	}
	return ctx.Err() // emulate the SDK failing on an already-canceled context
}

func (f *fakeDockerAPI) ContainerRemove(ctx context.Context, id string, opts container.RemoveOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Remove:"+id)
	if f.removeForces == nil {
		f.removeForces = map[string]bool{}
	}
	f.removeForces[id] = opts.Force
	f.removeCtxErr = ctx.Err()
	if err := f.removeErrs[id]; err != nil {
		return err
	}
	return f.removeErr
}

func (f *fakeDockerAPI) ContainerList(_ context.Context, opts container.ListOptions) ([]container.Summary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "List")
	f.listOpts = opts
	return f.listed, f.listErr
}

func (f *fakeDockerAPI) ContainerLogs(_ context.Context, id string, opts container.LogsOptions) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Output:"+id)
	f.logsOpts = opts
	return f.logsReader, f.logsErr
}

func (f *fakeDockerAPI) CopyToContainer(_ context.Context, id, dstPath string, content io.Reader, _ container.CopyToContainerOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "Copy:"+id)
	f.copyCount++
	f.copyDst = dstPath
	data, _ := io.ReadAll(content)
	f.copyTar = data
	return f.copyErr
}

// callLog returns a copy of the recorded call order.
func (f *fakeDockerAPI) callLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func newDockerTestRuntime(t *testing.T) (*DockerRuntime, *fakeDockerAPI, *bytes.Buffer) {
	t.Helper()
	fake := &fakeDockerAPI{createdID: "c-1"}
	var logs bytes.Buffer
	cfg := config.Config{K6Image: "grafana/k6", MaxConcurrentRuns: 3, RunTimeoutMS: 1000}
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{}))
	return NewDockerRuntime(fake, cfg, logger), fake, &logs
}

func TestCreateAppliesLimitsLabelsNetworkAndImage(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	spec := Spec{
		Image:     "custom/k6:1.0",
		Network:   "k6flow-net",
		Command:   []string{"run"},
		Args:      []string{"--quiet", ScriptPath},
		Env:       map[string]string{"ZED": "z", "ALPHA": "a"},
		Labels:    map[string]string{LabelRunID: "run-42", "team": "core"},
		CPUMillis: 500, MemoryMiB: 256,
	}
	id, err := rt.Create(context.Background(), spec)
	if err != nil || id != "c-1" {
		t.Fatalf("Create = (%q, %v), want (\"c-1\", nil)", id, err)
	}
	if got := fake.callLog(); len(got) != 1 || got[0] != "Create" {
		t.Fatalf("calls = %v, want [Create]", got)
	}
	if fake.cfg.Image != "custom/k6:1.0" {
		t.Errorf("Image = %q", fake.cfg.Image)
	}
	if fake.host.NanoCPUs != 500_000_000 {
		t.Errorf("NanoCPUs = %d, want 500000000", fake.host.NanoCPUs)
	}
	if fake.host.Memory != 268_435_456 {
		t.Errorf("Memory = %d, want 268435456", fake.host.Memory)
	}
	if string(fake.host.NetworkMode) != "k6flow-net" {
		t.Errorf("NetworkMode = %q", fake.host.NetworkMode)
	}
	if fake.cfg.Labels[LabelManaged] != "true" || fake.cfg.Labels[LabelRunID] != "run-42" ||
		fake.cfg.Labels["team"] != "core" {
		t.Errorf("Labels = %v", fake.cfg.Labels)
	}
	if len(fake.cfg.Cmd) != 3 || fake.cfg.Cmd[0] != "run" || fake.cfg.Cmd[1] != "--quiet" ||
		fake.cfg.Cmd[2] != ScriptPath {
		t.Errorf("Cmd = %v", fake.cfg.Cmd)
	}
	if joined := strings.Join(fake.cfg.Env, ","); joined != "ALPHA=a,ZED=z" {
		t.Errorf("Env = %q, want sorted ALPHA=a,ZED=z", joined)
	}
	if fake.netConf == nil || fake.platform != nil || fake.name != "" {
		t.Errorf("create extras: netConf=%v platform=%v name=%q", fake.netConf, fake.platform, fake.name)
	}
}

func TestCreateImageFallbackAndEmptyRejection(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	if _, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1}); err != nil {
		t.Fatalf("fallback create: %v", err)
	}
	if fake.cfg.Image != "grafana/k6" {
		t.Errorf("Image = %q, want config default", fake.cfg.Image)
	}

	empty := NewDockerRuntime(&fakeDockerAPI{createdID: "c-2"}, config.Config{},
		slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{})))
	_, err := empty.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1})
	if err == nil || !strings.Contains(err.Error(), "image") {
		t.Errorf("empty-image create err = %v, want image error", err)
	}
}

func TestCreateCPUAndMemoryBoundaries(t *testing.T) {
	cases := []struct {
		name             string
		cpu, mem         int
		wantNano, wantBy int64
	}{
		{"one_milli_and_one_mib", 1, 1, 1_000_000, 1_048_576},
		{"typical", 500, 256, 500_000_000, 268_435_456},
		{"max_valid_limits", 9_223_372_036_854, 8_796_093_022_207,
			9_223_372_036_854_000_000, 9_223_372_036_853_727_232},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt, fake, _ := newDockerTestRuntime(t)
			if _, err := rt.Create(context.Background(),
				Spec{CPUMillis: tc.cpu, MemoryMiB: tc.mem}); err != nil {
				t.Fatalf("Create: %v", err)
			}
			if fake.host.NanoCPUs != tc.wantNano {
				t.Errorf("NanoCPUs = %d, want %d", fake.host.NanoCPUs, tc.wantNano)
			}
			if fake.host.Memory != tc.wantBy {
				t.Errorf("Memory = %d, want %d", fake.host.Memory, tc.wantBy)
			}
		})
	}
}

func TestCreateRejectsOutOfRangeLimits(t *testing.T) {
	cases := []struct {
		name       string
		cpu, mem   int
		wantErrStr string
	}{
		{"zero_cpu", 0, 1, "cpuMillis"},
		{"negative_cpu", -1, 1, "cpuMillis"},
		{"overflow_cpu", math.MaxInt64, 1, "cpuMillis"},
		{"max_safe_cpu_overflow", 1<<53 - 1, 1, "cpuMillis"},
		{"zero_mem", 1, 0, "memoryMiB"},
		{"negative_mem", 1, -1, "memoryMiB"},
		{"overflow_mem", 1, 1<<53 - 1, "memoryMiB"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt, fake, _ := newDockerTestRuntime(t)
			_, err := rt.Create(context.Background(), Spec{CPUMillis: tc.cpu, MemoryMiB: tc.mem})
			if err == nil || !strings.Contains(err.Error(), tc.wantErrStr) {
				t.Errorf("err = %v, want mention of %s", err, tc.wantErrStr)
			}
			if got := fake.callLog(); len(got) != 0 {
				t.Errorf("no SDK call expected, got %v", got)
			}
		})
	}
}

func TestCreateForcesManagedLabel(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	if _, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1,
		Labels: map[string]string{LabelManaged: "false"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if fake.cfg.Labels[LabelManaged] != "true" {
		t.Errorf("managed label = %q, want forced true", fake.cfg.Labels[LabelManaged])
	}
}

func TestCreateDeliversScriptViaInMemoryTar(t *testing.T) {
	rt, fake, logs := newDockerTestRuntime(t)
	script := "import http from 'k6/http'; export default function () {}"
	if _, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1,
		Env: map[string]string{ScriptEnvKey: script, "TARGET_URL": "http://example.test"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if fake.copyCount != 1 || fake.copyDst != "/" {
		t.Fatalf("copy count = %d dst = %q, want 1 at /", fake.copyCount, fake.copyDst)
	}
	containerEnv := strings.Join(fake.cfg.Env, "\x00")
	if strings.Contains(containerEnv, script) || strings.Contains(containerEnv, ScriptEnvKey) {
		t.Errorf("script leaked into container env: %q", containerEnv)
	}
	if !strings.Contains(containerEnv, "TARGET_URL=http://example.test") {
		t.Errorf("plain env missing: %q", containerEnv)
	}
	tr := tar.NewReader(bytes.NewReader(fake.copyTar))
	dir, err := tr.Next()
	if err != nil || dir.Name != "k6flow/" || dir.Typeflag != tar.TypeDir {
		t.Fatalf("first tar entry = %+v, %v; want dir k6flow/", dir, err)
	}
	file, err := tr.Next()
	if err != nil || file.Name != "k6flow/script.js" || file.Size != int64(len(script)) {
		t.Fatalf("second tar entry = %+v, %v; want k6flow/script.js", file, err)
	}
	body, _ := io.ReadAll(tr)
	if string(body) != script {
		t.Errorf("script bytes = %q", body)
	}
	if _, err := tr.Next(); !errors.Is(err, io.EOF) {
		t.Errorf("extra tar entries: %v", err)
	}
	if out := logs.String(); strings.Contains(out, script) ||
		strings.Contains(out, "http://example.test") || !strings.Contains(out, "container created") {
		t.Errorf("log hygiene/lifecycle mismatch: %s", out)
	}
}

func TestDiagnosticImmediateStopPreservesLoadDefault(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	if err := rt.Stop(context.Background(), "c", 0); err != nil { t.Fatal(err) }
	if fake.stopOpts.Timeout != nil { t.Fatal("load default changed") }
	if err := rt.Stop(context.Background(), "c", -time.Nanosecond); err != nil { t.Fatal(err) }
	if fake.stopOpts.Timeout == nil || *fake.stopOpts.Timeout != 0 { t.Fatal("diagnostic stop was not immediate") }
}

func TestDiagnosticEntryDeliveryFailureCleanup(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	fake.copyErr = errors.New("copy failed")
	_, err := rt.Create(context.Background(), Spec{CPUMillis:1, MemoryMiB:1, DiagnosticEntry:[]byte("entry"), Env:map[string]string{ScriptEnvKey:"source"}})
	if err == nil || !fake.removeForces[fake.createdID] { t.Fatal("delivery error did not force cleanup") }
}

func TestDiagnosticEntryDelivery(t *testing.T) {
	rt, fake, logs := newDockerTestRuntime(t)
	entry := []byte("server-owned-entry-secret")
	source := "submitted-source-secret"
	_, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1, DiagnosticEntry: entry, Env: map[string]string{ScriptEnvKey: source}})
	if err != nil { t.Fatal(err) }
	files := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(fake.copyTar))
	for { header, err := tr.Next(); if errors.Is(err, io.EOF) { break }; if err != nil { t.Fatal(err) }; if header.Typeflag == tar.TypeReg { data, _ := io.ReadAll(tr); files[header.Name] = string(data) } }
	if len(files) != 2 || files["k6flow/script.js"] != source || files["k6flow/diagnostic.js"] != string(entry) { t.Fatalf("wrong fixed tar entries: %v", files) }
	if strings.Contains(strings.Join(fake.cfg.Env, ","), source) || strings.Contains(logs.String(), source) || strings.Contains(logs.String(), string(entry)) { t.Fatal("source leaked") }
}

func TestCreateWithoutScriptSkipsCopy(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	if _, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1,
		Env: map[string]string{"PLAIN": "v"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if fake.copyCount != 0 {
		t.Errorf("copyCount = %d, want 0", fake.copyCount)
	}
}

func TestCreateRemovesContainerWhenScriptDeliveryFails(t *testing.T) {
	fake := &fakeDockerAPI{createdID: "c-9", copyErr: errors.New("copy boom")}
	rt := NewDockerRuntime(fake, config.Config{K6Image: "grafana/k6", MaxConcurrentRuns: 1},
		slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{})))
	_, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1,
		Env: map[string]string{ScriptEnvKey: "x"}})
	if err == nil || !strings.Contains(err.Error(), "deliver script") {
		t.Fatalf("err = %v, want deliver script failure", err)
	}
	got := fake.callLog()
	want := []string{"Create", "Copy:c-9", "Remove:c-9"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if !fake.removeForces["c-9"] {
		t.Errorf("fallback remove must force")
	}
}

func TestCreatePropagatesAPIError(t *testing.T) {
	fake := &fakeDockerAPI{createErr: errors.New("daemon down")}
	rt := NewDockerRuntime(fake, config.Config{K6Image: "grafana/k6"},
		slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{})))
	id, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1})
	if id != "" || err == nil || !strings.Contains(err.Error(), "daemon down") {
		t.Errorf("Create = (%q, %v), want (\"\", daemon down)", id, err)
	}
}

func TestLifecycleOrderWaitExitAndStopTimeout(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	fake.waitResp = container.WaitResponse{StatusCode: 3}
	ctx := context.Background()
	id, err := rt.Create(ctx, Spec{CPUMillis: 1, MemoryMiB: 1})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rt.Start(ctx, id); err != nil {
		t.Fatalf("Start: %v", err)
	}
	code, err := rt.Wait(ctx, id)
	if err != nil || code != 3 {
		t.Fatalf("Wait = (%d, %v), want (3, nil)", code, err)
	}
	if err := rt.Stop(ctx, id, 1500*time.Millisecond); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := rt.Remove(ctx, id, true); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	want := []string{"Create", "Start:c-1", "Wait:c-1", "Stop:c-1", "Remove:c-1"}
	if got := fake.callLog(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("order = %v, want %v", got, want)
	}
	if fake.waitCondUsed != container.WaitConditionNotRunning {
		t.Errorf("wait condition = %q", fake.waitCondUsed)
	}
	if fake.stopOpts.Timeout == nil || *fake.stopOpts.Timeout != 2 {
		t.Errorf("stop timeout = %v, want 2s (rounded up)", fake.stopOpts.Timeout)
	}
	if !fake.removeForces["c-1"] {
		t.Errorf("Remove must record force=true")
	}
}

func TestWaitErrorPaths(t *testing.T) {
	t.Run("channel_error", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.waitErr = errors.New("wait boom")
		if code, err := rt.Wait(context.Background(), "c-1"); code != 0 ||
			err == nil || !strings.Contains(err.Error(), "wait boom") {
			t.Errorf("Wait = (%d, %v)", code, err)
		}
	})
	t.Run("container_error_status", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.waitResp = container.WaitResponse{
			Error: &container.WaitExitError{Message: "exploded"},
		}
		if _, err := rt.Wait(context.Background(), "c-1"); err == nil ||
			!strings.Contains(err.Error(), "exploded") {
			t.Errorf("err = %v, want exploded", err)
		}
	})
	t.Run("context_canceled", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.waitBlock = true
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := rt.Wait(ctx, "c-1"); !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	})
}

func TestStopTimeoutMappingAndErrors(t *testing.T) {
	cases := []struct {
		in      time.Duration
		wantSec *int
	}{
		{0, nil},
		{100 * time.Millisecond, intPtr(1)},
		{time.Second, intPtr(1)},
		{1500 * time.Millisecond, intPtr(2)},
	}
	for _, tc := range cases {
		rt, fake, _ := newDockerTestRuntime(t)
		if err := rt.Stop(context.Background(), "c-1", tc.in); err != nil {
			t.Fatalf("Stop(%v): %v", tc.in, err)
		}
		switch {
		case tc.wantSec == nil && fake.stopOpts.Timeout != nil:
			t.Errorf("Stop(%v) timeout = %d, want nil", tc.in, *fake.stopOpts.Timeout)
		case tc.wantSec != nil && fake.stopOpts.Timeout == nil:
			t.Errorf("Stop(%v) timeout = nil, want %d", tc.in, *tc.wantSec)
		case tc.wantSec != nil && *fake.stopOpts.Timeout != *tc.wantSec:
			t.Errorf("Stop(%v) timeout = %d, want %d", tc.in, *fake.stopOpts.Timeout, *tc.wantSec)
		}
	}
	rt, fake, _ := newDockerTestRuntime(t)
	fake.stopErr = errors.New("stop boom")
	if err := rt.Stop(context.Background(), "c-1", time.Second); err == nil ||
		!strings.Contains(err.Error(), "stop boom") {
		t.Errorf("err = %v, want stop boom", err)
	}
}

func intPtr(v int) *int { return &v }

func TestRemovePropagatesError(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	fake.removeErr = errors.New("remove boom")
	if err := rt.Remove(context.Background(), "c-1", false); err == nil ||
		!strings.Contains(err.Error(), "remove boom") {
		t.Errorf("err = %v, want remove boom", err)
	}
	if fake.removeForces["c-1"] {
		t.Errorf("force passthrough: want false")
	}
}

func TestCleanupGuaranteesRemove(t *testing.T) {
	t.Run("stop_failure_still_removes", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.stopErr = errors.New("stop boom")
		err := rt.Cleanup(context.Background(), "c-1")
		if err == nil || !strings.Contains(err.Error(), "stop boom") {
			t.Fatalf("Cleanup err = %v", err)
		}
		got := fake.callLog()
		want := []string{"Stop:c-1", "Remove:c-1"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("calls = %v, want %v", got, want)
		}
		if !fake.removeForces["c-1"] {
			t.Errorf("fallback remove must force")
		}
	})
	t.Run("both_succeed_in_order", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		if err := rt.Cleanup(context.Background(), "c-1"); err != nil {
			t.Fatalf("Cleanup: %v", err)
		}
		got := fake.callLog()
		want := []string{"Stop:c-1", "Remove:c-1"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("calls = %v, want %v", got, want)
		}
	})
	t.Run("canceled_context_still_removes", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := rt.Cleanup(ctx, "c-1")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Cleanup err = %v, want context.Canceled", err)
		}
		got := fake.callLog()
		want := []string{"Stop:c-1", "Remove:c-1"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("calls = %v, want %v", got, want)
		}
		if fake.removeCtxErr != nil {
			t.Errorf("Remove ran with canceled ctx: %v", fake.removeCtxErr)
		}
	})
}

func TestListLabeledFiltersManagedContainers(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	fake.listed = []container.Summary{{ID: "a"}, {ID: "b"}}
	ids, err := rt.ListLabeled(context.Background())
	if err != nil || strings.Join(ids, ",") != "a,b" {
		t.Fatalf("ListLabeled = (%v, %v)", ids, err)
	}
	if !fake.listOpts.All {
		t.Errorf("List must include stopped containers (All=false)")
	}
	got := fake.listOpts.Filters.Get("label")
	if len(got) != 1 || got[0] != LabelManaged+"=true" {
		t.Errorf("label filter = %v, want [%s=true]", got, LabelManaged)
	}
	t.Run("error_propagation", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.listErr = errors.New("list boom")
		ids, err := rt.ListLabeled(context.Background())
		if ids != nil || err == nil || !strings.Contains(err.Error(), "list boom") {
			t.Errorf("ListLabeled = (%v, %v)", ids, err)
		}
	})
}

func TestReconcileOrphansSemantics(t *testing.T) {
	t.Run("removes_each_labeled_container", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.listed = []container.Summary{{ID: "o-1"}, {ID: "o-2"}}
		removed, err := rt.ReconcileOrphans(context.Background())
		if err != nil || removed != 2 {
			t.Fatalf("ReconcileOrphans = (%d, %v), want (2, nil)", removed, err)
		}
		got := fake.callLog()
		want := []string{"List", "Remove:o-1", "Remove:o-2"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("calls = %v, want %v", got, want)
		}
		if !fake.removeForces["o-1"] || !fake.removeForces["o-2"] {
			t.Errorf("orphans must be force-removed: %v", fake.removeForces)
		}
	})
	t.Run("list_error_returns_error_and_skips_remove", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.listErr = errors.New("list boom")
		removed, err := rt.ReconcileOrphans(context.Background())
		if removed != 0 || err == nil || !strings.Contains(err.Error(), "list boom") {
			t.Errorf("ReconcileOrphans = (%d, %v)", removed, err)
		}
		if got := fake.callLog(); strings.Join(got, ",") != "List" {
			t.Errorf("calls = %v, want [List] only", got)
		}
	})
	t.Run("remove_errors_are_tolerated", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.listed = []container.Summary{{ID: "o-1"}, {ID: "o-2"}}
		fake.removeErrs = map[string]error{"o-1": errors.New("busy")}
		removed, err := rt.ReconcileOrphans(context.Background())
		if err != nil || removed != 1 {
			t.Fatalf("ReconcileOrphans = (%d, %v), want (1, nil)", removed, err)
		}
		if got := fake.callLog(); strings.Join(got, ",") != "List,Remove:o-1,Remove:o-2" {
			t.Errorf("both removals must be attempted: %v", got)
		}
	})
	t.Run("nothing_listed", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		removed, err := rt.ReconcileOrphans(context.Background())
		if err != nil || removed != 0 {
			t.Errorf("ReconcileOrphans = (%d, %v)", removed, err)
		}
		if got := fake.callLog(); strings.Join(got, ",") != "List" {
			t.Errorf("calls = %v, want [List]", got)
		}
	})
}

func TestOutputReturnsLogReader(t *testing.T) {
	rt, fake, _ := newDockerTestRuntime(t)
	fake.logsReader = io.NopCloser(strings.NewReader(`{"type":"Point","metric":"checks"}` + "\n"))
	rc, err := rt.Output(context.Background(), "c-1")
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	body, _ := io.ReadAll(rc)
	if !strings.Contains(string(body), `"metric":"checks"`) {
		t.Errorf("reader body = %q", body)
	}
	if !fake.logsOpts.ShowStdout || !fake.logsOpts.ShowStderr || !fake.logsOpts.Follow {
		t.Errorf("logs options = %+v, want stdout+stderr+follow", fake.logsOpts)
	}
	t.Run("error_propagation", func(t *testing.T) {
		rt, fake, _ := newDockerTestRuntime(t)
		fake.logsErr = errors.New("logs boom")
		rc, err := rt.Output(context.Background(), "c-1")
		if rc != nil || err == nil || !strings.Contains(err.Error(), "logs boom") {
			t.Errorf("Output = (%v, %v)", rc, err)
		}
	})
}

func TestSemaphoreBlocksUntilRelease(t *testing.T) {
	s := NewSemaphore(1)
	if err := s.Acquire(context.Background()); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	deadline, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := s.Acquire(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("second acquire err = %v, want DeadlineExceeded", err)
	}
	s.Release()
	if err := s.Acquire(context.Background()); err != nil {
		t.Errorf("acquire after release: %v", err)
	}
}

func TestSemaphoreAcquireHonorsCancellation(t *testing.T) {
	s := NewSemaphore(1)
	if err := s.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Acquire(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestSemaphoreReleaseWithoutAcquireIsNoop(t *testing.T) {
	s := NewSemaphore(1)
	done := make(chan struct{})
	go func() {
		s.Release()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Release without Acquire blocked")
	}
	if err := s.Acquire(context.Background()); err != nil {
		t.Errorf("slot lost: %v", err)
	}
}

func TestSemaphoreZeroClampsToSingleSlot(t *testing.T) {
	s := NewSemaphore(0)
	if err := s.Acquire(context.Background()); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	deadline, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := s.Acquire(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want single-slot blocking", err)
	}
}

func TestSemaphoreConcurrentAcquireStaysWithinLimit(t *testing.T) {
	s := NewSemaphore(3)
	var wg sync.WaitGroup
	var inFlight, peak atomic.Int64
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Acquire(context.Background()); err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			cur := inFlight.Add(1)
			for {
				old := peak.Load()
				if cur <= old || peak.CompareAndSwap(old, cur) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			inFlight.Add(-1)
			s.Release()
		}()
	}
	wg.Wait()
	if got := peak.Load(); got > 3 {
		t.Errorf("peak concurrency = %d, want <= 3", got)
	}
	if got := inFlight.Load(); got != 0 {
		t.Errorf("leaked slots: inFlight = %d", got)
	}
}

func TestNewDockerRuntimeWiresConfig(t *testing.T) {
	rt, _, _ := newDockerTestRuntime(t)
	if cap(rt.sem.ch) != 3 {
		t.Errorf("semaphore cap = %d, want 3 (MaxConcurrentRuns)", cap(rt.sem.ch))
	}
	if rt.stopTimeout != time.Second {
		t.Errorf("stopTimeout = %v, want 1s (RunTimeoutMS)", rt.stopTimeout)
	}
	if rt.image != "grafana/k6" {
		t.Errorf("image = %q", rt.image)
	}
	for i := 0; i < 3; i++ {
		if err := rt.Acquire(context.Background()); err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
	}
	deadline, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := rt.Acquire(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("4th acquire err = %v, want DeadlineExceeded", err)
	}
	rt.Release()
	if err := rt.Acquire(context.Background()); err != nil {
		t.Errorf("acquire after Release: %v", err)
	}
}

func TestLifecycleLogsNeverContainScriptOrEnvValues(t *testing.T) {
	rt, fake, logs := newDockerTestRuntime(t)
	script := "const SUPER_SECRET = 'script-body-marker';"
	fake.waitResp = container.WaitResponse{StatusCode: 0}
	ctx := context.Background()
	id, err := rt.Create(ctx, Spec{CPUMillis: 1, MemoryMiB: 1,
		Env: map[string]string{ScriptEnvKey: script, "API_TOKEN": "tok-12345"}})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rt.Start(ctx, id); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := rt.Wait(ctx, id); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := rt.Cleanup(ctx, id); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	out := logs.String()
	for _, want := range []string{"container created", "container started",
		"container exited", "container stopped", "container removed"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing lifecycle event %q in logs", want)
		}
	}
	for _, secret := range []string{script, "script-body-marker", "tok-12345", ScriptEnvKey} {
		if strings.Contains(out, secret) {
			t.Errorf("secret %q leaked into logs", secret)
		}
	}
}

// k6flow-variables V-T3: user env (K6FLOW_VAR_*) reaches the container env
// while the reserved script key stays stripped.
func TestCreatePassesVariableEnvAndStripsScript(t *testing.T) {
	rt, fake, logs := newDockerTestRuntime(t)
	if _, err := rt.Create(context.Background(), Spec{CPUMillis: 1, MemoryMiB: 1,
		Env: map[string]string{ScriptEnvKey: "script-body", "K6FLOW_VAR_TOKEN": "tok-var-secret"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if env := strings.Join(fake.cfg.Env, "\n"); env != "K6FLOW_VAR_TOKEN=tok-var-secret" {
		t.Errorf("container env = %q, want only K6FLOW_VAR_TOKEN=tok-var-secret", env)
	}
	if strings.HasPrefix(ScriptEnvKey, "K6FLOW_VAR_") {
		t.Errorf("reserved script key %q must not share the K6FLOW_VAR_ prefix", ScriptEnvKey)
	}
	if strings.Contains(logs.String(), "tok-var-secret") {
		t.Errorf("logs leak env value: %s", logs.String())
	}
}
