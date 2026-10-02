//go:build integration

// Real-Docker integration tests for K6F2-05: the full handler→engine→Docker
// stack against the host engine and the real grafana/k6 image, plus the curl
// end-to-end probe of the real cmd/server binary (init:184). Run with:
//
//	GOCACHE="$PWD/node_modules/.go-cache" GOMODCACHE="$PWD/node_modules/.go-mod-cache" \
//	  go test -tags integration -count=1 ./internal/engine/ -v
//
// Scripts are bounded (≤5s duration, 1 VU, sleeping iterations — no request
// storms). Every test skips explicitly and only when the Docker daemon is
// unreachable; otherwise failures are real failures. t.Cleanup force-removes
// leftover labeled containers even when a test fails.
package engine_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"k6flow/apps/orchestrator/internal/config"
	"k6flow/apps/orchestrator/internal/engine"
	"k6flow/apps/orchestrator/internal/k6sum"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// realK6Image is the conformance-proven image (grafana/k6 v2.3.0 observed).
const realK6Image = "grafana/k6"

// Bounded scripts: 1 VU, ≤5s, one sleeping iteration cycle each so output
// stays small (the writer measured request storms at ~30 MB/s without sleep).
const (
	// finishScript emits http_reqs/http_req_failed/http_req_duration (one
	// refused request per iteration) plus one passing and one failing check
	// per iteration; no thresholds, so k6 exits 0 → finished.
	finishScript = `import http from "k6/http";
import { check, sleep } from "k6";
export default function () {
  http.get("http://127.0.0.1:1/");
  check({}, { "always passes": () => true });
  check({}, { "never passes": () => false });
  sleep(0.5);
}
`
	// stopScript runs long enough for the stop path to observe a live run.
	stopScript = `import { sleep } from "k6";
export default function () { sleep(1); }
`
	// invalidScript fails k6's script compile → non-zero exit → failed.
	invalidScript = "this is not valid javascript {{{"

	// conformanceScript exercises the real check metric: one passing and one
	// failing check per iteration (name recorded by TestRealK6CheckConformance).
	conformanceScript = `import { check, sleep } from "k6";
export default function () {
  check({ status: 200 }, { "status is 200": (r) => r.status === 200 });
  check({ status: 200 }, { "status is 500": (r) => r.status === 500 });
  sleep(0.2);
}
`
)

// isDockerUnreachable classifies connection-class failures — the only reason
// these tests skip (K6F2-05 contract: report skips explicitly).
func isDockerUnreachable(err error) bool {
	msg := strings.ToLower(err.Error())
	for _, needle := range []string{
		"cannot connect to the docker daemon",
		"is the docker daemon running",
		"no such file or directory", // docker.sock missing
		"connection refused",
		"permission denied",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

// realClient constructs the official SDK client (lazy) and proves the daemon
// is reachable; unreachable ⇒ explicit t.Skip, anything else ⇒ failure.
func realClient(t *testing.T) *client.Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatalf("docker client construction: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := cli.Ping(ctx); err != nil {
		if isDockerUnreachable(err) {
			t.Skipf("Docker daemon unreachable — skipping real-Docker integration test: %v", err)
		}
		t.Fatalf("docker ping: %v", err)
	}
	return cli
}

// ensureK6Image pulls grafana/k6 when absent (network authorized for this
// unit) and verifies it afterwards.
func ensureK6Image(t *testing.T, cli *client.Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	present := func() bool {
		list, err := cli.ImageList(ctx, image.ListOptions{
			Filters: filters.NewArgs(filters.Arg("reference", realK6Image)),
		})
		if err != nil {
			t.Fatalf("image list %s: %v", realK6Image, err)
		}
		return len(list) > 0
	}
	if present() {
		return
	}
	t.Logf("image %s absent — pulling (network authorized)", realK6Image)
	pull, err := cli.ImagePull(ctx, realK6Image+":latest", image.PullOptions{})
	if err != nil {
		t.Fatalf("image pull %s: %v", realK6Image, err)
	}
	if _, err := io.Copy(io.Discard, pull); err != nil {
		pull.Close()
		t.Fatalf("read pull response: %v", err)
	}
	pull.Close()
	if !present() {
		t.Fatalf("image %s still absent after pull", realK6Image)
	}
}

// demuxRT mirrors cmd/server's decoratedRuntime: package main cannot be
// imported, so the test carries its own copy of the Output demux that strips
// Docker's multiplex framing and drops k6 stderr noise before k6sum parses.
type demuxRT struct {
	inner runtime.ContainerRuntime
}

func (d *demuxRT) Create(ctx context.Context, spec runtime.Spec) (string, error) {
	spec.Args = withQuietFlag(spec.Args)
	return d.inner.Create(ctx, spec)
}

// withQuietFlag injects k6's --quiet once — see cmd/server's copy: k6 v2.3
// progress output on STDOUT interleaves with JSON points mid-line without it.
func withQuietFlag(args []string) []string {
	for _, arg := range args {
		if arg == "--quiet" {
			return args
		}
	}
	out := make([]string, 0, len(args)+1)
	out = append(out, "--quiet")
	out = append(out, args...)
	return out
}

func (d *demuxRT) Start(ctx context.Context, containerID string) error {
	return d.inner.Start(ctx, containerID)
}

func (d *demuxRT) Wait(ctx context.Context, containerID string) (int, error) {
	return d.inner.Wait(ctx, containerID)
}

func (d *demuxRT) Stop(ctx context.Context, containerID string, timeout time.Duration) error {
	return d.inner.Stop(ctx, containerID, timeout)
}

func (d *demuxRT) Remove(ctx context.Context, containerID string, force bool) error {
	return d.inner.Remove(ctx, containerID, force)
}

func (d *demuxRT) ListLabeled(ctx context.Context) ([]string, error) {
	return d.inner.ListLabeled(ctx)
}

// Output mirrors cmd/server's decoratedRuntime.Output: strip the multiplex
// framing (dropping stderr), then select the JSON-LINES channel — k6 v2.3
// prints its banner and end-of-run summary on stdout even with `--out json`,
// and k6sum's fail-the-summary policy must never see those bytes.
func (d *demuxRT) Output(ctx context.Context, containerID string) (io.ReadCloser, error) {
	raw, err := d.inner.Output(ctx, containerID)
	if err != nil {
		return nil, err
	}
	framed, frameWriter := io.Pipe()
	go func() {
		_, copyErr := stdcopy.StdCopy(frameWriter, io.Discard, raw)
		frameWriter.CloseWithError(copyErr)
		_ = raw.Close()
	}()
	pr, pw := io.Pipe()
	go func() { filterJSONLines(framed, pw) }()
	return pr, nil
}

// filterJSONLines copies only '{'-opening lines and drops k6 chatter (banner,
// end-of-run summary, progress); mirrors cmd/server's helper of the same name.
func filterJSONLines(src io.ReadCloser, dst *io.PipeWriter) {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 64*1024), 1<<20) // mirrors k6sum.MaxLineBytes
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		if _, err := dst.Write(line); err != nil {
			_ = src.Close()
			return
		}
		if _, err := dst.Write([]byte("\n")); err != nil {
			_ = src.Close()
			return
		}
	}
	_ = src.Close()
	dst.CloseWithError(scanner.Err())
}

// realHarness wires a store, a real engine and the real DockerRuntime.
type realHarness struct {
	store  *runs.Store
	engine *engine.Engine
	docker *runtime.DockerRuntime
	rt     *demuxRT
	logs   *syncBuffer
}

func newRealHarness(t *testing.T) *realHarness {
	t.Helper()
	cli := realClient(t)
	ensureK6Image(t, cli)
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	cfg := config.Config{K6Image: realK6Image, MaxConcurrentRuns: 2, MaxVUsPerRun: 10, RunTimeoutMS: 5000}
	docker := runtime.NewDockerRuntime(cli, cfg, logger)
	// Idempotent-ish start: sweep leftovers of previous (crashed) runs.
	if removed, err := docker.ReconcileOrphans(context.Background()); err != nil {
		t.Logf("startup ReconcileOrphans failed (continuing): %v", err)
	} else {
		t.Logf("startup ReconcileOrphans removed %d container(s)", removed)
	}
	rt := &demuxRT{inner: docker}
	store := runs.NewStore()
	h := &realHarness{
		store:  store,
		engine: engine.New(engine.Deps{Store: store, Runtime: rt, Sem: runtime.NewSemaphore(2), K6Image: realK6Image, Log: logger}),
		docker: docker,
		rt:     rt,
		logs:   logs,
	}
	t.Cleanup(h.guaranteeCleanup)
	return h
}

// guaranteeCleanup force-removes every labeled container even when the test
// fails mid-flight (K6F2-05: no orphan leaks from the suite itself).
func (h *realHarness) guaranteeCleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids, err := h.docker.ListLabeled(ctx)
	if err != nil {
		return
	}
	for _, id := range ids {
		_ = h.docker.Remove(ctx, id, true)
	}
}

func (h *realHarness) createRealRun(t *testing.T, script string, durationMs int) string {
	t.Helper()
	run, err := h.store.Create(runs.Run{
		Script:     script,
		VUs:        1,
		DurationMs: durationMs,
		CPUMillis:  100,
		MemoryMiB:  64,
	})
	if err != nil {
		t.Fatalf("store.Create: %v", err)
	}
	return run.ID
}

// waitTerminal polls until the run is terminal AND its summary decision is
// visible (the engine stores the summary right after the status, except for
// failed runs which never carry one).
func (h *realHarness) waitTerminal(t *testing.T, id string, timeout time.Duration) runs.Run {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := runs.Status("unknown")
	for time.Now().Before(deadline) {
		run, ok := h.store.Get(id)
		if ok {
			last = run.Status
			switch run.Status {
			case runs.StatusFinished, runs.StatusStopped:
				if run.Summary != nil {
					return run
				}
			case runs.StatusFailed:
				return run
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("run %s not terminal within %v (last status %q); engine logs:\n%s", id, timeout, last, h.logs.String())
	return runs.Run{}
}

// waitNoManagedContainers asserts container removal via ListLabeled (empty =
// every container created for this suite is gone).
func (h *realHarness) waitNoManagedContainers(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var ids []string
	var err error
	for time.Now().Before(deadline) {
		ids, err = h.docker.ListLabeled(context.Background())
		if err == nil && len(ids) == 0 {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("managed containers not removed within %v (ids %v, err %v); engine logs:\n%s", timeout, ids, err, h.logs.String())
}

// TestRealRunFinishesWithSummary launches a real k6 run through the engine
// and asserts the finish path end-to-end: finished status, persisted summary
// (requests > 0, failedChecks > 0 via the `checks` conformance fix, finite
// non-negative latencies, thresholdsPassed) and container removal.
func TestRealRunFinishesWithSummary(t *testing.T) {
	h := newRealHarness(t)
	id := h.createRealRun(t, finishScript, 1500)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.engine.Launch(ctx, id); err != nil {
		t.Fatalf("Launch: %v; engine logs:\n%s", err, h.logs.String())
	}
	run := h.waitTerminal(t, id, 90*time.Second)
	if run.Status != runs.StatusFinished {
		t.Fatalf("status = %s, want finished (k6 exit 0); engine logs:\n%s", run.Status, h.logs.String())
	}
	sum := run.Summary
	if sum.Totals.Requests <= 0 {
		t.Errorf("totals.requests = %d, want > 0", sum.Totals.Requests)
	}
	if sum.Totals.Errors < 1 {
		t.Errorf("totals.errors = %d, want >= 1 (every request is refused locally)", sum.Totals.Errors)
	}
	if sum.Totals.FailedChecks < 1 {
		t.Errorf("totals.failedChecks = %d, want >= 1 — real k6 emits `checks` (plural), counted after the K6F2-05 conformance fix", sum.Totals.FailedChecks)
	}
	for name, value := range map[string]float64{
		"avgMs": sum.LatencyMs.Avg, "p90Ms": sum.LatencyMs.P90,
		"p95Ms": sum.LatencyMs.P95, "p99Ms": sum.LatencyMs.P99,
	} {
		if value < 0 {
			t.Errorf("latency %s = %v, want >= 0", name, value)
		}
	}
	if !sum.ThresholdsPassed {
		t.Error("thresholdsPassed = false, want true for exit code 0")
	}
	h.waitNoManagedContainers(t, 60*time.Second)
}

// TestRealRunStopRemovesContainer launches a longer run, stops it through the
// engine and asserts stopped status, the terminal-summary invariant and
// container removal.
func TestRealRunStopRemovesContainer(t *testing.T) {
	h := newRealHarness(t)
	id := h.createRealRun(t, stopScript, 5000)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.engine.Launch(ctx, id); err != nil {
		t.Fatalf("Launch: %v; engine logs:\n%s", err, h.logs.String())
	}
	if err := h.engine.Stop(context.Background(), id); err != nil {
		t.Fatalf("Stop: %v; engine logs:\n%s", err, h.logs.String())
	}
	run := h.waitTerminal(t, id, 60*time.Second)
	if run.Status != runs.StatusStopped {
		t.Fatalf("status = %s, want stopped; engine logs:\n%s", run.Status, h.logs.String())
	}
	if run.Summary == nil {
		t.Error("summary = nil; stopped runs must keep the terminal-summary invariant (parsed or all-zero)")
	}
	h.waitNoManagedContainers(t, 60*time.Second)
}

// TestRealRunInvalidScriptFailsAndCleansUp proves guaranteed cleanup on the
// failure path: a broken script terminalizes as failed with no summary and
// the container is removed.
func TestRealRunInvalidScriptFailsAndCleansUp(t *testing.T) {
	h := newRealHarness(t)
	id := h.createRealRun(t, invalidScript, 1000)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := h.engine.Launch(ctx, id); err != nil {
		t.Fatalf("Launch: %v; engine logs:\n%s", err, h.logs.String())
	}
	run := h.waitTerminal(t, id, 60*time.Second)
	if run.Status != runs.StatusFailed {
		t.Fatalf("status = %s, want failed (k6 rejects the script); engine logs:\n%s", run.Status, h.logs.String())
	}
	if run.Summary != nil {
		t.Errorf("summary = %+v, want nil for failed runs", run.Summary)
	}
	h.waitNoManagedContainers(t, 60*time.Second)
}

// TestRealK6CheckConformance is the CRITICAL conformance probe resolving
// advisory R3-k6-checks-name: it reads the raw (demuxed) stdout of a real
// grafana/k6 run, records the exact check metric name k6 emits, and proves
// k6sum counts its value-0 points into failedChecks.
func TestRealK6CheckConformance(t *testing.T) {
	h := newRealHarness(t)
	spec := runtime.Spec{
		Image:     realK6Image,
		Command:   []string{"run"},
		Args:      []string{"--out", "json", "--vus", "1", "--duration", "1000ms", runtime.ScriptPath},
		Env:       map[string]string{runtime.ScriptEnvKey: conformanceScript},
		Labels:    map[string]string{runtime.LabelRunID: "test-run-k6f205-conformance"},
		CPUMillis: 100,
		MemoryMiB: 64,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	containerID, err := h.rt.Create(ctx, spec)
	if err != nil {
		t.Fatalf("Create: %v; engine logs:\n%s", err, h.logs.String())
	}
	t.Cleanup(func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()
		_ = h.docker.Remove(cleanupCtx, containerID, true)
	})
	if err := h.rt.Start(ctx, containerID); err != nil {
		t.Fatalf("Start: %v", err)
	}
	exit, err := h.rt.Wait(ctx, containerID)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	raw := rawOutput(t, h, containerID)
	if exit != 0 {
		t.Fatalf("k6 exit = %d, want 0 (checks are not thresholds) — output tail:\n%s", exit, tailOutput(raw))
	}
	// The exact metric name from real output — this is the recorded
	// conformance finding: "checks" (plural), value 1 = passed, 0 = failed.
	if !bytes.Contains(raw, []byte(`"metric":"checks"`)) {
		t.Errorf("real k6 output does not carry the metric name `checks`; k6sum's MetricCheck needs the observed name. Output tail:\n%s", tailOutput(raw))
	}
	summary, err := k6sum.Parse(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("k6sum.Parse(real k6 output): %v\noutput tail: %s", err, tailOutput(raw))
	}
	if summary.Totals.FailedChecks < 1 {
		t.Errorf("failedChecks = %d, want >= 1 (value-0 `checks` points from the failing check)", summary.Totals.FailedChecks)
	}
	t.Logf("conformance: metric name observed = checks, failedChecks parsed = %d, output bytes = %d", summary.Totals.FailedChecks, len(raw))
	if err := h.docker.Remove(context.Background(), containerID, true); err != nil {
		t.Errorf("Remove: %v", err)
	}
}

// rawOutput attaches to the container log stream (demuxed) and reads it all;
// Wait has already returned, so Follow delivers the full stream and EOF.
func rawOutput(t *testing.T, h *realHarness, containerID string) []byte {
	t.Helper()
	reader, err := h.rt.Output(context.Background(), containerID)
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read container output: %v", err)
	}
	return data
}

func tailOutput(data []byte) string {
	const tail = 2000
	if len(data) <= tail {
		return string(data)
	}
	return "...(truncated)... " + string(data[len(data)-tail:])
}

// --- curl end-to-end (init:184) -------------------------------------------

// curlTranscript records the exact curl commands and their key outputs.
type curlTranscript struct {
	mu    sync.Mutex
	lines []string
}

func (c *curlTranscript) add(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, line)
}

func (c *curlTranscript) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.lines, "\n")
}

// tryCurl runs the real curl binary with the status-code trailer, returns
// body + HTTP status, and records the exact command line and its outcome in
// the transcript. Transport errors (e.g. the server not accepting
// connections yet) are returned instead of fatal so callers can retry.
func tryCurl(tr *curlTranscript, args ...string) (body string, status int, err error) {
	writeOut := "\n%{http_code}"
	cmdLine := "curl -sS -w " + strconv.Quote(writeOut) + " " + strings.Join(args, " ")
	tr.add(cmdLine)
	cmd := exec.Command("curl", append([]string{"-sS", "-w", writeOut}, args...)...)
	out, cmdErr := cmd.CombinedOutput()
	if cmdErr != nil {
		tr.add(fmt.Sprintf("  → transport error: %v", cmdErr))
		return "", 0, fmt.Errorf("%s\n  failed: %v\n  output: %s", cmdLine, cmdErr, out)
	}
	recv := string(out)
	idx := strings.LastIndexByte(recv, '\n')
	if idx < 0 {
		return "", 0, fmt.Errorf("%s\n  no status line in output: %q", cmdLine, recv)
	}
	status, convErr := strconv.Atoi(strings.TrimSpace(recv[idx+1:]))
	if convErr != nil {
		return "", 0, fmt.Errorf("%s\n  status line not numeric: %q", cmdLine, recv[idx+1:])
	}
	body = recv[:idx]
	preview := body
	if len(preview) > 300 {
		preview = preview[:300] + "…"
	}
	tr.add(fmt.Sprintf("  → %d %s", status, preview))
	return body, status, nil
}

// curlOut is tryCurl with fatal transport errors (the settled-state steps).
func curlOut(t *testing.T, tr *curlTranscript, args ...string) (body string, status int) {
	t.Helper()
	body, status, err := tryCurl(tr, args...)
	if err != nil {
		t.Fatal(err)
	}
	return body, status
}

func mustJSONBody(t *testing.T, payload map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	return string(raw)
}

var runIDPattern = regexp.MustCompile(`"runId":"([^"]+)"`)
var statusPattern = regexp.MustCompile(`"status":"([^"]+)"`)

// TestCurlEndToEnd starts the real cmd/server binary and drives init:184's
// full curl flow: public healthz, 401 without/with wrong Bearer, 202 + runId,
// state polling to a terminal run, summary 200 with version:1, the stop flow,
// graceful shutdown and a final orphan check.
func TestCurlEndToEnd(t *testing.T) {
	cli := realClient(t)
	ensureK6Image(t, cli)
	tr := &curlTranscript{}
	defer func() { t.Logf("curl transcript:\n%s", tr.String()) }()

	// Free loopback port for the server.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocate port: %v", err)
	}
	addr := listener.Addr().String()
	listener.Close()
	baseURL := "http://" + addr

	// Build the real binary (spec: go build + run in background).
	binary := filepath.Join(t.TempDir(), "k6flow-server")
	if out, err := exec.Command("go", "build", "-o", binary, "../../cmd/server").CombinedOutput(); err != nil {
		t.Fatalf("go build cmd/server: %v\n%s", err, out)
	}

	token := "k6f2-05-e2e-token"
	serverLog := &syncBuffer{}
	server := exec.Command(binary)
	server.Env = append(os.Environ(),
		"SERVICE_TOKEN="+token,
		"ORCHESTRATOR_ADDR="+addr,
		"LOG_LEVEL=info",
		"K6_IMAGE="+realK6Image,
		"MAX_CONCURRENT_RUNS=2",
	)
	server.Stdout = serverLog
	server.Stderr = serverLog
	if err := server.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- server.Wait() }()
	serverWaited := false // the body may consume `exited` during shutdown
	t.Cleanup(func() {
		if serverWaited {
			return
		}
		_ = server.Process.Kill()
		<-exited
	})

	// Wait for readiness through the public probe (tolerating the first
	// connection attempts while the server binds).
	readyDeadline := time.Now().Add(120 * time.Second)
	for {
		body, status, err := tryCurl(tr, baseURL+"/healthz")
		if err == nil && status == 200 && strings.TrimSpace(body) == `{"status":"ok"}` {
			break
		}
		if time.Now().After(readyDeadline) {
			t.Fatalf("server not ready after 120s (err=%v status=%d body=%q); server log:\n%s", err, status, body, serverLog.String())
		}
		time.Sleep(300 * time.Millisecond)
	}
	// §1 wiring evidence: ReconcileOrphans ran against the real daemon.
	waitForLog(t, serverLog, "startup orphan reconciliation finished", 30*time.Second)

	auth := "Authorization: Bearer " + token
	contentType := "Content-Type: application/json"
	startBody := mustJSONBody(t, map[string]any{
		"version": 1, "script": finishScript, "vus": 1,
		"durationMs": 1500, "cpuMillis": 100, "memoryMiB": 64,
	})

	// 1-2: unauthenticated and wrong-token starts are rejected with 401.
	if _, status := curlOut(t, tr, "-X", "POST", baseURL+"/api/runs", "-H", contentType, "-d", startBody); status != 401 {
		t.Errorf("POST /api/runs without auth = %d, want 401", status)
	}
	if _, status := curlOut(t, tr, "-X", "POST", baseURL+"/api/runs", "-H", contentType, "-H", "Authorization: Bearer wrong-token", "-d", startBody); status != 401 {
		t.Errorf("POST /api/runs with wrong bearer = %d, want 401", status)
	}

	// 3: authenticated start → 202 + runId.
	body, status := curlOut(t, tr, "-X", "POST", baseURL+"/api/runs", "-H", contentType, "-H", auth, "-d", startBody)
	if status != 202 {
		t.Fatalf("POST /api/runs = %d, want 202 (body %s)", status, body)
	}
	runID := extract(t, runIDPattern, body, "runId")

	// 4: poll state until terminal → finished.
	waitForRunState(t, tr, serverLog, baseURL, auth, runID, "finished", 120*time.Second)

	// 5: summary 200 with version:1 and thresholdsPassed.
	sum1Body, sum1Status := curlOut(t, tr, baseURL+"/api/runs/"+runID+"/summary", "-H", auth)
	if sum1Status != 200 {
		t.Errorf("finished summary = %d, want 200 (body %s)", sum1Status, sum1Body)
	}
	if !strings.Contains(sum1Body, `"version":1`) {
		t.Errorf("summary missing version:1: %s", sum1Body)
	}
	if !strings.Contains(sum1Body, `"thresholdsPassed":true`) {
		t.Errorf("summary missing thresholdsPassed:true: %s", sum1Body)
	}

	// 6: stop flow — start a longer run, stop it, watch it converge.
	stopBody := mustJSONBody(t, map[string]any{
		"version": 1, "script": stopScript, "vus": 1,
		"durationMs": 5000, "cpuMillis": 100, "memoryMiB": 64,
	})
	body, status = curlOut(t, tr, "-X", "POST", baseURL+"/api/runs", "-H", contentType, "-H", auth, "-d", stopBody)
	if status != 202 {
		t.Fatalf("POST /api/runs (stop script) = %d, want 202 (body %s)", status, body)
	}
	run2 := extract(t, runIDPattern, body, "runId")
	if _, status := curlOut(t, tr, "-X", "POST", baseURL+"/api/runs/"+run2+"/stop", "-H", auth); status != 202 {
		t.Errorf("POST stop = %d, want 202", status)
	}
	stopState := waitForRunState(t, tr, serverLog, baseURL, auth, run2, "stopped", 90*time.Second)
	if stopState == "" {
		t.Fatal("stopped state empty")
	}

	// 7: stopped-run summary keeps version:1 but omits thresholdsPassed
	// (K6F2-04 verifier finding #4, verified over real HTTP).
	summaryBody, summaryStatus := curlOut(t, tr, baseURL+"/api/runs/"+run2+"/summary", "-H", auth)
	if summaryStatus != 200 {
		t.Errorf("stopped summary = %d, want 200 (body %s)", summaryStatus, summaryBody)
	}
	if !strings.Contains(summaryBody, `"version":1`) {
		t.Errorf("stopped summary missing version:1: %s", summaryBody)
	}
	if strings.Contains(summaryBody, "thresholdsPassed") {
		t.Errorf("stopped summary must omit thresholdsPassed: %s", summaryBody)
	}

	// 8: all containers are gone BEFORE shutdown (the engine removed them),
	// so the server's graceful stop has nothing labeled left to inherit.
	probe := independentRuntime(t, cli)
	waitLabelCount(t, probe, 0, 60*time.Second)

	// 9: graceful shutdown on SIGINT.
	if err := server.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatalf("signal server: %v", err)
	}
	select {
	case err := <-exited:
		serverWaited = true
		if err != nil {
			t.Errorf("server exit = %v, want clean shutdown; server log:\n%s", err, serverLog.String())
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("server did not shut down within 30s; server log:\n%s", serverLog.String())
	}
	if !strings.Contains(serverLog.String(), "shutdown signal received") {
		t.Errorf("graceful-shutdown log line missing; server log:\n%s", serverLog.String())
	}

	// 10: no orphan containers remain after the server is gone.
	waitLabelCount(t, probe, 0, 30*time.Second)
}

// waitForRunState polls GET state until it equals want (or fails on an
// unexpected terminal state, dumping the server log for diagnosis).
func waitForRunState(t *testing.T, tr *curlTranscript, serverLog *syncBuffer, baseURL, auth, runID, want string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := ""
	for time.Now().Before(deadline) {
		body, status := curlOut(t, tr, baseURL+"/api/runs/"+runID, "-H", auth)
		if status != 200 {
			t.Fatalf("GET state = %d, want 200 (body %s)", status, body)
		}
		last = extract(t, statusPattern, body, "status")
		switch last {
		case want:
			return body
		case "failed", "finished", "stopped":
			t.Fatalf("run %s reached %q, want %q (state %s); server log:\n%s", runID, last, want, body, serverLog.String())
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("run %s never reached %q within %v (last %q); server log:\n%s", runID, want, timeout, last, serverLog.String())
	return ""
}

func extract(t *testing.T, pattern *regexp.Regexp, body, what string) string {
	t.Helper()
	match := pattern.FindStringSubmatch(body)
	if match == nil {
		t.Fatalf("no %s in %q", what, body)
	}
	return match[1]
}

func waitForLog(t *testing.T, buf *syncBuffer, needle string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), needle) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("log line %q not observed within %v; log:\n%s", needle, timeout, buf.String())
}

// independentRuntime builds a separate view of managed containers for the
// orphan checks (independent of the server process that created them).
func independentRuntime(t *testing.T, cli *client.Client) *runtime.DockerRuntime {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return runtime.NewDockerRuntime(cli, config.Config{K6Image: realK6Image, MaxConcurrentRuns: 1, MaxVUsPerRun: 10, RunTimeoutMS: 5000}, logger)
}

func waitLabelCount(t *testing.T, rt *runtime.DockerRuntime, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var ids []string
	var err error
	for time.Now().Before(deadline) {
		ids, err = rt.ListLabeled(context.Background())
		if err == nil && len(ids) == want {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("managed container count = %d (want %d, ids %v, err %v) after %v", len(ids), want, ids, err, timeout)
}
