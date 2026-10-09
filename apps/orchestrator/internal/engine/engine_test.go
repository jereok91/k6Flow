package engine_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"k6flow/apps/orchestrator/internal/engine"
	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

const script = "import http from 'k6/http';\nconst SUP3RSECRET = 'do-not-log-me';\nexport default function () {}"

// k6Output is a valid JSON-LINES fixture: 3 requests, 1 error, 2 failed
// checks (of 3), latency samples 10..100 ms.
const k6Output = `{"type":"Metric","metric":{"type":"Counter","name":"http_reqs","contains":"count"}}
{"type":"Point","metric":"http_reqs","data":{"time":"2026-01-01T00:00:00Z","value":1,"tags":{}}}
{"type":"Point","metric":"http_reqs","data":{"time":"2026-01-01T00:00:01Z","value":1,"tags":{}}}
{"type":"Point","metric":"http_reqs","data":{"time":"2026-01-01T00:00:02Z","value":1,"tags":{}}}
{"type":"Metric","metric":{"type":"Rate","name":"http_req_failed","contains":"rate"}}
{"type":"Point","metric":"http_req_failed","data":{"time":"2026-01-01T00:00:01Z","value":0,"tags":{}}}
{"type":"Point","metric":"http_req_failed","data":{"time":"2026-01-01T00:00:02Z","value":1,"tags":{}}}
{"type":"Metric","metric":{"type":"Counter","name":"check","contains":"count"}}
{"type":"Point","metric":"check","data":{"time":"2026-01-01T00:00:01Z","value":1,"tags":{}}}
{"type":"Point","metric":"check","data":{"time":"2026-01-01T00:00:02Z","value":0,"tags":{}}}
{"type":"Point","metric":"check","data":{"time":"2026-01-01T00:00:03Z","value":0,"tags":{}}}
{"type":"Metric","metric":{"type":"Trend","name":"http_req_duration","contains":"time","unit":"ms"}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:01Z","value":10,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:02Z","value":20,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:03Z","value":30,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:04Z","value":40,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:05Z","value":50,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:06Z","value":60,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:07Z","value":70,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:08Z","value":80,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:09Z","value":90,"tags":{}}}
{"type":"Point","metric":"http_req_duration","data":{"time":"2026-01-01T00:00:10Z","value":100,"tags":{}}}
`

// syncBuffer is a mutex-guarded log capture safe under -race.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// blockingRuntime blocks Wait until the test releases it, so Stop and
// semaphore assertions are deterministic while a launch is in flight.
type blockingRuntime struct {
	*runtime.FakeRuntime
	release chan struct{}
}

func newBlockingRuntime() *blockingRuntime {
	return &blockingRuntime{FakeRuntime: runtime.NewFakeRuntime(), release: make(chan struct{})}
}

func (b *blockingRuntime) Wait(ctx context.Context, containerID string) (int, error) {
	select {
	case <-b.release:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	return b.FakeRuntime.Wait(ctx, containerID)
}

func (b *blockingRuntime) finishWait() { close(b.release) }

// fakeRT is the scripting/observation surface shared by FakeRuntime and the
// blocking test wrapper; both satisfy ContainerRuntime.
type fakeRT interface {
	runtime.ContainerRuntime
	Calls() []string
	Specs() []runtime.Spec
	SetExitCode(containerID string, code int)
	SetOutput(containerID, output string)
	SetError(key string, err error)
}

// harness bundles one engine with its store, fake runtime, semaphore and logs.
type harness struct {
	eng *engine.Engine
	rt  fakeRT
	sem *runtime.Semaphore
	st  *runs.Store
	log *syncBuffer
}

func newHarness(rt fakeRT) *harness {
	return newHarnessDeps(rt, nil, nil)
}

// newHarnessDeps extends newHarness with the live-metrics tap seams: an
// optional FrameSink (nil disables frames) and an optional clock for the
// window anchor (nil uses the real clock).
func newHarnessDeps(rt fakeRT, sink metrics.FrameSink, now func() time.Time) *harness {
	logs := &syncBuffer{}
	store := runs.NewStore()
	sem := runtime.NewSemaphore(1)
	return &harness{
		eng: engine.New(engine.Deps{
			Store:   store,
			Runtime: rt,
			Sem:     sem,
			K6Image: "grafana/k6:0.55.0",
			Log:     slog.New(slog.NewTextHandler(logs, nil)),
			Sink:    sink,
			Now:     now,
		}),
		rt:  rt,
		sem: sem,
		st:  store,
		log: logs,
	}
}

// createRun stores a pending run and returns its id.
func (h *harness) createRun(t *testing.T) string {
	t.Helper()
	run, err := h.st.Create(runs.Run{
		Script:      script,
		VUs:         2,
		DurationMs:  3000,
		CPUMillis:   250,
		MemoryMiB:   128,
		Attachments: []string{"att-1"},
	})
	if err != nil {
		t.Fatalf("store.Create: %v", err)
	}
	return run.ID
}

// finishRun drives a plain happy-path completion and returns the run.
func (h *harness) finishRun(t *testing.T, exit int) runs.Run {
	t.Helper()
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", exit)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	run, ok := h.st.Get(id)
	if !ok {
		t.Fatal("run disappeared from store")
	}
	return run
}

func (h *harness) waitForStatus(t *testing.T, id string, want runs.Status) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if run, ok := h.st.Get(id); ok && run.Status == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	run, ok := h.st.Get(id)
	if !ok {
		t.Fatalf("timed out waiting for status %q: run missing", want)
	}
	t.Fatalf("timed out waiting for status %q: still %q", want, run.Status)
}

func assertSemFree(t *testing.T, sem *runtime.Semaphore) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if err := sem.Acquire(ctx); err != nil {
		t.Fatalf("semaphore not released: %v", err)
	}
	sem.Release()
}

func assertSemHeld(t *testing.T, sem *runtime.Semaphore) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := sem.Acquire(ctx); err == nil {
		sem.Release()
		t.Fatal("semaphore unexpectedly free while run in flight")
	}
}

func (h *harness) assertCalls(t *testing.T, want ...string) {
	t.Helper()
	got := h.rt.Calls()
	if len(got) != len(want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("calls = %v, want %v (order matters)", got, want)
		}
	}
}

func TestLaunchRejectsUnknownRun(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	err := h.eng.Launch(context.Background(), "run-missing")
	if err == nil || !strings.Contains(err.Error(), "unknown run") {
		t.Fatalf("Launch error = %v, want unknown-run rejection", err)
	}
	h.assertCalls(t)
	assertSemFree(t, h.sem)
}

func TestLaunchRejectsCanceledContextWithoutCreating(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.eng.Launch(ctx, id); err == nil {
		t.Fatal("Launch error = nil, want context cancellation rejection")
	}
	h.assertCalls(t) // no container created
	run, _ := h.st.Get(id)
	if run.Status != runs.StatusPending {
		t.Errorf("status = %q, want pending (unchanged on early error)", run.Status)
	}
	assertSemFree(t, h.sem)
}

func TestLaunchFailsWhenSemaphoreExhaustedLeavingStatusPending(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	if err := h.sem.Acquire(context.Background()); err != nil {
		t.Fatalf("fill semaphore: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := h.eng.Launch(ctx, id); err == nil {
		t.Fatal("Launch error = nil, want semaphore-acquire failure")
	}
	h.assertCalls(t)
	run, _ := h.st.Get(id)
	if run.Status != runs.StatusPending {
		t.Errorf("status = %q, want pending (unchanged on early error)", run.Status)
	}
	h.sem.Release()
	assertSemFree(t, h.sem) // Launch did not leak the slot
}

func TestLaunchRejectsDoubleLaunchWhileInFlight(t *testing.T) {
	rt := newBlockingRuntime()
	h := newHarness(rt)
	id := h.createRun(t)
	rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("first Launch: %v", err)
	}
	err := h.eng.Launch(context.Background(), id)
	if err == nil || !strings.Contains(err.Error(), "already launched") {
		t.Fatalf("second Launch error = %v, want already-launched rejection", err)
	}
	assertSemHeld(t, h.sem) // first launch holds the slot
	rt.finishWait()
	h.waitForStatus(t, id, runs.StatusFinished)
	assertSemFree(t, h.sem)
}

func TestLaunchRejectsTerminalRun(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	run := h.finishRun(t, 0)
	err := h.eng.Launch(context.Background(), run.ID)
	if err == nil || !strings.Contains(err.Error(), "terminal") {
		t.Fatalf("Launch error = %v, want terminal rejection", err)
	}
}

func TestCompletionExit0PersistsFinishedSummary(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)

	run, _ := h.st.Get(id)
	if run.Summary == nil {
		t.Fatal("Summary = nil, want persisted summary")
	}
	wantTotals := runs.Totals{Requests: 3, Errors: 1, FailedChecks: 2}
	if run.Summary.Totals != wantTotals {
		t.Errorf("Totals = %+v, want %+v", run.Summary.Totals, wantTotals)
	}
	wantLatency := runs.LatencyMs{Avg: 55, P90: 90, P95: 100, P99: 100}
	if run.Summary.LatencyMs != wantLatency {
		t.Errorf("LatencyMs = %+v, want %+v", run.Summary.LatencyMs, wantLatency)
	}
	if !run.Summary.ThresholdsPassed {
		t.Error("ThresholdsPassed = false, want true for exit 0")
	}
	if run.StartedAt == nil || run.FinishedAt == nil {
		t.Errorf("timestamps = %v/%v, want both stamped", run.StartedAt, run.FinishedAt)
	}

	// Full lifecycle ordering: create, start, tap-attached Output (the
	// single consumer starts before Wait so frames stream while the run is
	// live), wait, cleanup Stop→Remove.
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Output:fake-1", "Wait:fake-1", "Stop:fake-1", "Remove:fake-1")
	assertSemFree(t, h.sem)

	// Spec built from run fields and config image.
	specs := h.rt.Specs()
	if len(specs) != 1 {
		t.Fatalf("Specs = %d, want 1", len(specs))
	}
	spec := specs[0]
	if spec.Image != "grafana/k6:0.55.0" {
		t.Errorf("Image = %q, want config image", spec.Image)
	}
	if spec.Env[runtime.ScriptEnvKey] != script {
		t.Error("script not delivered via reserved env key")
	}
	if spec.Labels[runtime.LabelRunID] != id {
		t.Errorf("run-id label = %q, want %q", spec.Labels[runtime.LabelRunID], id)
	}
	if spec.CPUMillis != 250 || spec.MemoryMiB != 128 {
		t.Errorf("limits = %d/%d, want 250/128", spec.CPUMillis, spec.MemoryMiB)
	}
	wantCmd := []string{"run", "--out", "json", "--vus", "2", "--duration", "3000ms", runtime.ScriptPath}
	gotCmd := append(append([]string(nil), spec.Command...), spec.Args...)
	if strings.Join(gotCmd, " ") != strings.Join(wantCmd, " ") {
		t.Errorf("command = %v, want %v", gotCmd, wantCmd)
	}

	// Log hygiene: lifecycle events present, script/secret bytes absent.
	logs := h.log.String()
	if !strings.Contains(logs, id) {
		t.Error("logs do not mention the run id")
	}
	if strings.Contains(logs, "do-not-log-me") || strings.Contains(logs, "SUP3RSECRET") || strings.Contains(logs, "import http") {
		t.Error("logs leaked script content")
	}
}

func TestCompletionExit99FinishesWithThresholdsFailed(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 99)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	run, _ := h.st.Get(id)
	if run.Summary == nil || run.Summary.ThresholdsPassed {
		t.Fatalf("Summary = %+v, want thresholdsPassed false", run.Summary)
	}
	if run.Summary.Totals.Requests != 3 {
		t.Errorf("Requests = %d, want 3", run.Summary.Totals.Requests)
	}
	assertSemFree(t, h.sem)
}

func TestCompletionCrashExitFailsWithoutSummary(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 1)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFailed)
	run, _ := h.st.Get(id)
	if run.Summary != nil {
		t.Errorf("Summary = %+v, want nil for crash", run.Summary)
	}
	// The tap attaches Output exactly once per run regardless of outcome.
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Output:fake-1", "Wait:fake-1", "Stop:fake-1", "Remove:fake-1")
	assertSemFree(t, h.sem)
}

func TestCompletionWaitErrorFailsWithoutSummary(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetError("Wait:fake-1", errors.New("wait exploded"))
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFailed)
	run, _ := h.st.Get(id)
	if run.Summary != nil {
		t.Errorf("Summary = %+v, want nil on wait error", run.Summary)
	}
	assertSemFree(t, h.sem)
}

func TestCompletionParseErrorFailsRunAndStillCleansUp(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", "this is not json-lines\n")
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFailed)
	run, _ := h.st.Get(id)
	if run.Summary != nil {
		t.Errorf("Summary = %+v, want nil on parse failure", run.Summary)
	}
	// Tap-attached Output precedes Wait; the parse still fails on the pipe
	// and the run still fails with guaranteed cleanup.
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Output:fake-1", "Wait:fake-1", "Stop:fake-1", "Remove:fake-1")
	assertSemFree(t, h.sem)
}

func TestCompletionOutputErrorFailsRun(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetError("Output:fake-1", errors.New("logs unavailable"))
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFailed)
	run, _ := h.st.Get(id)
	if run.Summary != nil {
		t.Errorf("Summary = %+v, want nil when output cannot be attached", run.Summary)
	}
	assertSemFree(t, h.sem)
}

func TestLaunchStartErrorCleansUpFailsRunAndReleasesSlot(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetError("Start:fake-1", errors.New("start exploded"))
	if err := h.eng.Launch(context.Background(), id); err == nil {
		t.Fatal("Launch error = nil, want start failure")
	}
	run, _ := h.st.Get(id)
	if run.Status != runs.StatusFailed {
		t.Errorf("status = %q, want failed (launch failure terminalizes)", run.Status)
	}
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Stop:fake-1", "Remove:fake-1")
	assertSemFree(t, h.sem)
}

func TestLaunchCreateErrorFailsRunAndReleasesSlot(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetError("Create", errors.New("create exploded"))
	if err := h.eng.Launch(context.Background(), id); err == nil {
		t.Fatal("Launch error = nil, want create failure")
	}
	run, _ := h.st.Get(id)
	if run.Status != runs.StatusFailed {
		t.Errorf("status = %q, want failed (launch failure terminalizes)", run.Status)
	}
	h.assertCalls(t, "Create:fake-1") // no container id → nothing to remove
	assertSemFree(t, h.sem)
}

func TestStopFinalizesStoppedRunThroughNormalCompletion(t *testing.T) {
	rt := newBlockingRuntime()
	h := newHarness(rt)
	id := h.createRun(t)
	rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	assertSemHeld(t, h.sem) // in flight: slot taken while Wait blocks

	if err := h.eng.Stop(context.Background(), id); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	rt.finishWait() // container exit follows the stop request
	h.waitForStatus(t, id, runs.StatusStopped)

	run, _ := h.st.Get(id)
	if run.Summary == nil {
		t.Fatal("Summary = nil, want partial summary persisted for stopped run")
	}
	if run.Summary.ThresholdsPassed {
		t.Error("ThresholdsPassed = true, want false for stopped run")
	}
	if run.Summary.Totals.Requests != 3 {
		t.Errorf("Requests = %d, want 3 from partial output", run.Summary.Totals.Requests)
	}
	// Stop reached the runtime after the tap attached Output (index 2) and
	// before the completion path's Wait resolves and cleanup Stop→Remove.
	calls := rt.Calls()
	if len(calls) < 4 || calls[2] != "Output:fake-1" || calls[3] != "Stop:fake-1" {
		t.Errorf("calls = %v, want Output:fake-1 then Stop:fake-1 before Wait resolves", calls)
	}
	assertSemFree(t, h.sem)
}

func TestStopOverridesNonzeroExitCodeMapping(t *testing.T) {
	rt := newBlockingRuntime()
	h := newHarness(rt)
	id := h.createRun(t)
	rt.SetExitCode("fake-1", 1) // crash exit, but stop was requested first
	rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	if err := h.eng.Stop(context.Background(), id); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	rt.finishWait()
	h.waitForStatus(t, id, runs.StatusStopped)
	run, _ := h.st.Get(id)
	if run.Summary == nil || run.Summary.ThresholdsPassed {
		t.Errorf("Summary = %+v, want thresholdsPassed false", run.Summary)
	}
}

func TestStopUnknownRunIsAnError(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	if err := h.eng.Stop(context.Background(), "run-missing"); err == nil {
		t.Fatal("Stop error = nil, want unknown-run rejection")
	}
	h.assertCalls(t)
}

func TestStopTerminalRunIsANoOp(t *testing.T) {
	rt := runtime.NewFakeRuntime()
	h := newHarness(rt)
	run := h.finishRun(t, 0)
	before := len(rt.Calls())
	if err := h.eng.Stop(context.Background(), run.ID); err != nil {
		t.Fatalf("Stop on terminal run: %v", err)
	}
	if len(rt.Calls()) != before {
		t.Errorf("runtime calls grew: %v", rt.Calls()[before:])
	}
}

func TestStopUnlaunchedRunIsANoOp(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	if err := h.eng.Stop(context.Background(), id); err != nil {
		t.Fatalf("Stop on unlaunched run: %v", err)
	}
	h.assertCalls(t)
	run, _ := h.st.Get(id)
	if run.Status != runs.StatusPending {
		t.Errorf("status = %q, want pending (engine.Stop does not transition unlaunched runs)", run.Status)
	}
}

// recordingSink captures live-metrics frames emitted through the tap.
type recordingSink struct {
	mu     sync.Mutex
	frames []metrics.MetricsFrame
}

func (s *recordingSink) OnFrame(f metrics.MetricsFrame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, f)
}

func (s *recordingSink) snapshot() []metrics.MetricsFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]metrics.MetricsFrame(nil), s.frames...)
}

// panickingSink models a broken subscriber path to prove tap isolation.
type panickingSink struct{}

func (panickingSink) OnFrame(metrics.MetricsFrame) { panic("sink boom") }

// tapClock is the fixed window-anchor clock for tap tests.
var tapClock = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

// pointAt builds a k6 Point line stamped run-relative to the tap clock.
func pointAt(offsetMs int, metric, value string) string {
	ts := tapClock.Add(time.Duration(offsetMs) * time.Millisecond).UTC().Format(time.RFC3339Nano)
	return fmt.Sprintf(`{"type":"Point","metric":%q,"data":{"time":%q,"value":%s,"tags":{}}}`, metric, ts, value)
}

// multiWindowOutput spans four windows: window 0 (request + latency + vus),
// window 1 (request + failure), window 2 (failed check only), window 3
// (request; final line has no trailing newline to exercise EOF feeding).
func multiWindowOutput() string {
	lines := []string{
		`{"type":"Metric","metric":{"type":"Counter","name":"http_reqs","contains":"count"}}`,
		pointAt(100, "http_reqs", "1"),
		pointAt(100, "http_req_duration", "42.5"),
		pointAt(100, "http_req_failed", "1"),
		pointAt(100, "vus", "3"),
		pointAt(1100, "http_reqs", "1"),
		pointAt(2100, "checks", "0"),
		pointAt(3100, "http_reqs", "1"),
		pointAt(4100, "http_reqs", "1"), // no trailing newline
	}
	return strings.Join(lines[:len(lines)-1], "\n") + "\n" + lines[len(lines)-1]
}

// TestTapFeedsSinkDuringRunWithMultiWindowFrames proves the Output() tap
// streams per-window frames (run-relative, fixed 1000 ms, monotonic seq)
// while preserving the summary path.
func TestTapFeedsSinkDuringRunWithMultiWindowFrames(t *testing.T) {
	sink := &recordingSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", multiWindowOutput())
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)

	frames := sink.snapshot()
	if len(frames) != 4 {
		t.Fatalf("frames = %d, want 4 completed windows (trailing partial not emitted)", len(frames))
	}
	want := []struct {
		startMs   int64
		rps       *float64
		failedChk int
	}{
		{0, ptr(1.0), 0},
		{1000, ptr(1.0), 0},
		{2000, nil, 1},
		{3000, ptr(1.0), 0},
	}
	for i, w := range want {
		f := frames[i]
		if f.Seq != int64(i) || f.Window.StartMs != w.startMs || f.Window.DurationMs != 1000 {
			t.Errorf("frame %d: seq=%d window=%+v, want seq=%d startMs=%d durationMs=1000",
				i, f.Seq, f.Window, i, w.startMs)
		}
		if f.Version != 1 || f.Type != "metrics" || f.RunID != id {
			t.Errorf("frame %d envelope: v%d type=%q runId=%q, want v1 metrics/%q", i, f.Version, f.Type, f.RunID, id)
		}
		if (f.ReqPerSec == nil) != (w.rps == nil) {
			t.Errorf("frame %d reqPerSec = %v, want null-ness %v", i, f.ReqPerSec, w.rps == nil)
		} else if f.ReqPerSec != nil && *f.ReqPerSec != *w.rps {
			t.Errorf("frame %d reqPerSec = %v, want %v", i, *f.ReqPerSec, *w.rps)
		}
		if f.FailedChecks != w.failedChk {
			t.Errorf("frame %d failedChecks = %d, want %d", i, f.FailedChecks, w.failedChk)
		}
		if f.ActiveVUs != 3 {
			t.Errorf("frame %d activeVUs = %d, want carried gauge 3", i, f.ActiveVUs)
		}
	}
	if v := frames[0].LatencyMs.Avg; v == nil || *v != 42.5 {
		t.Errorf("frame 0 latency avg = %v, want 42.5", v)
	}
	if v := frames[0].HTTPFailureFraction; v == nil || *v != 1 {
		t.Errorf("frame 0 httpFailureFraction = %v, want 1", v)
	}
	if v := frames[1].HTTPFailureFraction; v == nil || *v != 0 {
		t.Errorf("frame 1 httpFailureFraction = %v, want 0 (no failures in window)", v)
	}
}

func ptr(v float64) *float64 { return &v }

// TestTapKeepsFinalSummaryByteCompatibleWithSinkPresent re-runs the frozen
// k6Output fixture with a sink attached and asserts the stored summary is
// identical to the sinkless result (Totals 3/1/2, latency 55/90/100/100).
func TestTapKeepsFinalSummaryByteCompatibleWithSinkPresent(t *testing.T) {
	sink := &recordingSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time {
		return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	})
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)

	run, _ := h.st.Get(id)
	if run.Summary == nil {
		t.Fatal("Summary = nil, want persisted summary")
	}
	wantTotals := runs.Totals{Requests: 3, Errors: 1, FailedChecks: 2}
	if run.Summary.Totals != wantTotals {
		t.Errorf("Totals = %+v, want %+v (identical to sinkless run)", run.Summary.Totals, wantTotals)
	}
	wantLatency := runs.LatencyMs{Avg: 55, P90: 90, P95: 100, P99: 100}
	if run.Summary.LatencyMs != wantLatency {
		t.Errorf("LatencyMs = %+v, want %+v", run.Summary.LatencyMs, wantLatency)
	}
	if !run.Summary.ThresholdsPassed {
		t.Error("ThresholdsPassed = false, want true for exit 0")
	}
	frames := sink.snapshot()
	if len(frames) == 0 {
		t.Fatal("sink received no frames from the multi-second fixture")
	}
	for i, f := range frames {
		if f.Seq != int64(i) || f.Window.StartMs != int64(i)*1000 {
			t.Errorf("frame %d: seq=%d startMs=%d, want seq=%d startMs=%d (monotonic, gapless)",
				i, f.Seq, f.Window.StartMs, i, i*1000)
		}
	}
}

// TestTapSinkPanicDoesNotFailRun proves sink/aggregation failures are
// isolated: the run still finalizes with its summary.
func TestTapSinkPanicDoesNotFailRun(t *testing.T) {
	h := newHarnessDeps(runtime.NewFakeRuntime(), panickingSink{}, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", multiWindowOutput())
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)

	run, _ := h.st.Get(id)
	if run.Summary == nil {
		t.Fatal("Summary = nil, want summary despite sink panic")
	}
	wantTotals := runs.Totals{Requests: 4, Errors: 1, FailedChecks: 1}
	if run.Summary.Totals != wantTotals {
		t.Errorf("Totals = %+v, want %+v", run.Summary.Totals, wantTotals)
	}
	wantLatency := runs.LatencyMs{Avg: 42.5, P90: 42.5, P95: 42.5, P99: 42.5}
	if run.Summary.LatencyMs != wantLatency {
		t.Errorf("LatencyMs = %+v, want %+v", run.Summary.LatencyMs, wantLatency)
	}
	if !strings.Contains(h.log.String(), "metrics aggregation panic recovered") {
		t.Error("logs do not record the recovered sink panic")
	}
}

// TestTapConsumesOutputExactlyOnce proves the tap is the single consumer:
// sink and k6sum share one Output() attachment (pipe), never two reads.
func TestTapConsumesOutputExactlyOnce(t *testing.T) {
	sink := &recordingSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time {
		return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	})
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)

	count := 0
	for _, c := range h.rt.Calls() {
		if strings.HasPrefix(c, "Output:") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("Output() calls = %d, want exactly 1 (single consumer)", count)
	}
	if len(sink.snapshot()) == 0 {
		t.Error("sink received no frames although Output carried points")
	}
}

// --- K6F3-03: terminal run notification (RunFinisher.OnRunFinished) ------

// notifyingSink records frames and terminal notifications in one sink. The
// optional onFinished hook runs synchronously INSIDE OnRunFinished (before
// the finished counter is bumped), so a test that observes the bump also
// observes everything the hook recorded — no sleeps, race-detector clean.
type notifyingSink struct {
	mu         sync.Mutex
	frames     []metrics.MetricsFrame
	finished   []string
	onFinished func(runID string)
}

func (s *notifyingSink) OnFrame(f metrics.MetricsFrame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, f)
}

func (s *notifyingSink) OnRunFinished(runID string) {
	s.mu.Lock()
	hook := s.onFinished
	s.mu.Unlock()
	if hook != nil {
		hook(runID) // recorded before the bump so observation implies completion
	}
	s.mu.Lock()
	s.finished = append(s.finished, runID)
	s.mu.Unlock()
}

func (s *notifyingSink) finishedCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.finished)
}

func (s *notifyingSink) finishedIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.finished...)
}

func (s *notifyingSink) frameCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}

// waitForFinished polls until OnRunFinished fired at least want times (the
// notification is asynchronous with respect to the terminal SetStatus).
func waitForFinished(t *testing.T, sink *notifyingSink, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if sink.finishedCount() >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("OnRunFinished fired %d time(s), want >= %d", sink.finishedCount(), want)
}

// waitCallsContain polls the runtime call log for a substring (completion
// barrier: after cleanup's Remove the completion path can notify no more).
func waitCallsContain(t *testing.T, h *harness, needle string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, c := range h.rt.Calls() {
			if c == needle {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("runtime calls never contained %q; calls = %v", needle, h.rt.Calls())
}

// TestTerminalCompletionNotifiesRunFinishedExactlyOnce drives every
// completion path (finished exit 0, finished thresholds-failed exit 99,
// failed crash/parse/wait error, stopped) and asserts: OnRunFinished fires
// for the right runId, at least once by the time cleanup finished, and
// EXACTLY once (after the Remove barrier no second call may exist).
func TestTerminalCompletionNotifiesRunFinishedExactlyOnce(t *testing.T) {
	cases := []struct {
		name string
		want runs.Status
		// setup configures the fake runtime for the path (br is non-nil only
		// for the stopped case, whose launch must block on Wait).
		setup     func(t *testing.T, rt fakeRT, id string)
		blocking  bool
		driveStop bool
	}{
		{
			name: "finished exit 0",
			want: runs.StatusFinished,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetExitCode("fake-1", 0)
				rt.SetOutput("fake-1", k6Output)
			},
		},
		{
			name: "finished exit 99 thresholds failed",
			want: runs.StatusFinished,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetExitCode("fake-1", 99)
				rt.SetOutput("fake-1", k6Output)
			},
		},
		{
			name: "failed by crash exit",
			want: runs.StatusFailed,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetExitCode("fake-1", 1)
			},
		},
		{
			name: "failed by parse error",
			want: runs.StatusFailed,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetOutput("fake-1", "this is not json-lines\n")
			},
		},
		{
			name: "failed by wait error",
			want: runs.StatusFailed,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetError("Wait:fake-1", errors.New("wait exploded"))
			},
		},
		{
			name: "stopped",
			want: runs.StatusStopped,
			setup: func(t *testing.T, rt fakeRT, id string) {
				rt.SetOutput("fake-1", k6Output)
			},
			blocking:  true,
			driveStop: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var rt fakeRT
			var blocking *blockingRuntime
			if tc.blocking {
				blocking = newBlockingRuntime()
				rt = blocking
			} else {
				rt = runtime.NewFakeRuntime()
			}
			sink := &notifyingSink{}
			h := newHarnessDeps(rt, sink, func() time.Time { return tapClock })
			id := h.createRun(t)
			tc.setup(t, rt, id)
			if err := h.eng.Launch(context.Background(), id); err != nil {
				t.Fatalf("Launch: %v", err)
			}
			if tc.driveStop {
				if err := h.eng.Stop(context.Background(), id); err != nil {
					t.Fatalf("Stop: %v", err)
				}
				blocking.finishWait()
			}
			h.waitForStatus(t, id, tc.want)
			waitForFinished(t, sink, 1)
			// Completion barrier: cleanup ran ⇒ the completion path is done
			// ⇒ no further notification can arrive ⇒ exactly one must exist.
			waitCallsContain(t, h, "Remove:fake-1")
			ids := sink.finishedIDs()
			if len(ids) != 1 {
				t.Fatalf("OnRunFinished calls = %v, want exactly one for run %s", ids, id)
			}
			if ids[0] != id {
				t.Errorf("OnRunFinished runId = %q, want %q", ids[0], id)
			}
			assertSemFree(t, h.sem)
		})
	}
}

// TestLaunchFailureNotifiesRunFinished proves the post-promotion launch
// failure paths (create/start errors → failLaunch → failed) also notify:
// a subscriber connected to the running run must get its close.
func TestLaunchFailureNotifiesRunFinished(t *testing.T) {
	cases := []struct {
		name  string
		stage string
		calls []string // runtime calls at the end (create fails before Start)
	}{
		{"create error", "Create", []string{"Create:fake-1"}},
		{"start error", "Start", []string{"Create:fake-1", "Start:fake-1", "Stop:fake-1", "Remove:fake-1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sink := &notifyingSink{}
			h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
			id := h.createRun(t)
			h.rt.SetError(tc.stage, errors.New(tc.stage+" exploded"))
			if err := h.eng.Launch(context.Background(), id); err == nil {
				t.Fatal("Launch error = nil, want launch-stage failure")
			}
			h.waitForStatus(t, id, runs.StatusFailed)
			waitForFinished(t, sink, 1)
			// failLaunch order: SetStatus → notify → sem.Release → deregister;
			// a free semaphore proves no second notification can follow.
			assertSemFree(t, h.sem)
			ids := sink.finishedIDs()
			if len(ids) != 1 || ids[0] != id {
				t.Errorf("OnRunFinished calls = %v, want exactly [%s]", ids, id)
			}
			h.assertCalls(t, tc.calls...)
		})
	}
}

// TestNonTerminalPathsNeverNotifyRunFinished pins the negative contract:
// rejections that change no status (unknown run, canceled context, exhausted
// semaphore, Stop on unknown/unlaunched runs) never notify; a double-launch
// rejection notifies exactly once — when the first launch later completes.
func TestNonTerminalPathsNeverNotifyRunFinished(t *testing.T) {
	t.Run("early launch rejections", func(t *testing.T) {
		sink := &notifyingSink{}
		h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
		if err := h.eng.Launch(context.Background(), "run-missing"); err == nil {
			t.Fatal("Launch(unknown) error = nil")
		}
		id := h.createRun(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := h.eng.Launch(ctx, id); err == nil {
			t.Fatal("Launch(canceled) error = nil")
		}
		if err := h.sem.Acquire(context.Background()); err != nil {
			t.Fatalf("fill semaphore: %v", err)
		}
		ctxSem, cancelSem := context.WithTimeout(context.Background(), 30*time.Millisecond)
		err := h.eng.Launch(ctxSem, id)
		cancelSem()
		if err == nil {
			t.Fatal("Launch(exhausted semaphore) error = nil")
		}
		h.sem.Release()
		if err := h.eng.Stop(context.Background(), id); err != nil {
			t.Fatalf("Stop(unlaunched): %v", err)
		}
		if err := h.eng.Stop(context.Background(), "run-missing"); err == nil {
			t.Fatal("Stop(unknown) error = nil")
		}
		// Settle window: nothing terminalized ⇒ nothing may have notified.
		time.Sleep(50 * time.Millisecond)
		if n := sink.finishedCount(); n != 0 {
			t.Fatalf("OnRunFinished fired %d time(s) for non-terminal paths", n)
		}
	})

	t.Run("double launch notifies once at completion", func(t *testing.T) {
		rt := newBlockingRuntime()
		sink := &notifyingSink{}
		h := newHarnessDeps(rt, sink, func() time.Time { return tapClock })
		id := h.createRun(t)
		rt.SetOutput("fake-1", k6Output)
		if err := h.eng.Launch(context.Background(), id); err != nil {
			t.Fatalf("first Launch: %v", err)
		}
		if err := h.eng.Launch(context.Background(), id); err == nil {
			t.Fatal("second Launch error = nil, want double-launch rejection")
		}
		if n := sink.finishedCount(); n != 0 {
			t.Fatalf("OnRunFinished fired %d time(s) while the run is still in flight", n)
		}
		rt.finishWait()
		h.waitForStatus(t, id, runs.StatusFinished)
		waitForFinished(t, sink, 1)
		waitCallsContain(t, h, "Remove:fake-1")
		if n := sink.finishedCount(); n != 1 {
			t.Fatalf("OnRunFinished calls = %d, want exactly 1 (double launch must not duplicate)", n)
		}
	})
}

// TestRunFinishedFiresAfterFramesSummaryAndBeforeCleanup pins the exact
// ordering inside OnRunFinished's hook (deterministic, no sleeps):
//   - the run is already terminal AND its summary is persisted (notify
//     follows SetStatus + SetSummary),
//   - every window frame has been emitted (notify follows the joined tap;
//     the trailing partial window never emits),
//   - cleanup has NOT run yet (notify precedes Stop→Remove), and Wait has
//     already returned.
func TestRunFinishedFiresAfterFramesSummaryAndBeforeCleanup(t *testing.T) {
	sink := &notifyingSink{}
	var (
		mu       sync.Mutex
		observed = struct {
			calls  []string
			frames int
			run    runs.Run
			found  bool
		}{}
	)
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	sink.onFinished = func(runID string) {
		run, found := h.st.Get(runID)
		mu.Lock()
		defer mu.Unlock()
		observed.calls = h.rt.Calls()
		observed.frames = sink.frameCount()
		observed.run, observed.found = run, found
	}
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 0)
	h.rt.SetOutput("fake-1", multiWindowOutput())
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	waitForFinished(t, sink, 1)

	mu.Lock()
	calls := append([]string(nil), observed.calls...)
	frames := observed.frames
	run, found := observed.run, observed.found
	mu.Unlock()

	if !found {
		t.Fatal("run missing from store at OnRunFinished")
	}
	if run.Status != runs.StatusFinished {
		t.Errorf("status at notify = %q, want finished (after terminal SetStatus)", run.Status)
	}
	if run.Summary == nil {
		t.Error("summary at notify = nil, want persisted (notify follows SetSummary)")
	}
	if frames != 4 {
		t.Errorf("frames emitted at notify = %d, want 4 (all windows before notify; trailing partial deferred)", frames)
	}
	haveWait, haveStop, haveRemove := false, false, false
	for _, c := range calls {
		switch c {
		case "Wait:fake-1":
			haveWait = true
		case "Stop:fake-1":
			haveStop = true
		case "Remove:fake-1":
			haveRemove = true
		}
	}
	if !haveWait {
		t.Errorf("calls at notify = %v, want Wait:fake-1 already observed (tap joined first)", calls)
	}
	if haveStop || haveRemove {
		t.Errorf("calls at notify = %v, want no cleanup yet (notify precedes Cleanup)", calls)
	}

	// Completion barrier: once cleanup finished, no more frames may exist.
	waitCallsContain(t, h, "Remove:fake-1")
	if n := sink.frameCount(); n != frames {
		t.Errorf("frames after completion = %d, want %d (no post-terminal frames)", n, frames)
	}
}

// panickingRunFinisher fails only the terminal notification to prove the
// engine's isolation policy extends to OnRunFinished: a broken hub cannot
// corrupt the run or skip cleanup.
type panickingRunFinisher struct{ frames int }

func (p *panickingRunFinisher) OnFrame(metrics.MetricsFrame) { p.frames++ }
func (p *panickingRunFinisher) OnRunFinished(string)         { panic("finish boom") }

func TestRunFinishedPanicDoesNotFailCompletion(t *testing.T) {
	sink := &panickingRunFinisher{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 0)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	waitCallsContain(t, h, "Remove:fake-1")
	run, _ := h.st.Get(id)
	if run.Summary == nil {
		t.Error("Summary = nil, want completion unaffected by finisher panic")
	}
	if !strings.Contains(h.log.String(), "run-finished notification panic recovered") {
		t.Error("logs do not record the recovered notification panic")
	}
	assertSemFree(t, h.sem)
}

// --- Global runs feed: run lifecycle events (RunEventSink) ----------------

type runEvent struct {
	kind     string // "state" | "end"
	runID    string
	from, to runs.Status
	status   runs.Status
}

// eventSink records lifecycle events (and ignores frames).
type eventSink struct {
	mu     sync.Mutex
	events []runEvent
}

func (s *eventSink) OnFrame(metrics.MetricsFrame) {}

func (s *eventSink) OnRunState(run runs.Run, from, to runs.Status, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run.Status != to {
		panic(fmt.Sprintf("OnRunState run.Status = %s, want %s", run.Status, to))
	}
	s.events = append(s.events, runEvent{kind: "state", runID: run.ID, from: from, to: to})
}

func (s *eventSink) OnRunEnd(run runs.Run) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, runEvent{kind: "end", runID: run.ID, status: run.Status})
}

func (s *eventSink) snapshot() []runEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]runEvent(nil), s.events...)
}

func waitForEnd(t *testing.T, sink *eventSink) []runEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		evs := sink.snapshot()
		for _, e := range evs {
			if e.kind == "end" {
				return evs
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no end event; events = %+v", sink.snapshot())
	return nil
}

var _ engine.RunEventSink = (*eventSink)(nil)

func TestRunEventsEmittedAcrossLifecycle(t *testing.T) {
	sink := &eventSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 0)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	got := waitForEnd(t, sink)
	want := []runEvent{
		{kind: "state", runID: id, from: "", to: runs.StatusPending},
		{kind: "state", runID: id, from: runs.StatusPending, to: runs.StatusRunning},
		{kind: "state", runID: id, from: runs.StatusRunning, to: runs.StatusFinished},
		{kind: "end", runID: id, status: runs.StatusFinished},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events = %+v\nwant     %+v", got, want)
	}
}

func TestRunEventsEmittedOnLaunchFailure(t *testing.T) {
	sink := &eventSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetError("Create", errors.New("create exploded"))
	if err := h.eng.Launch(context.Background(), id); err == nil {
		t.Fatal("Launch error = nil")
	}
	got := waitForEnd(t, sink)
	want := []runEvent{
		{kind: "state", runID: id, from: "", to: runs.StatusPending},
		{kind: "state", runID: id, from: runs.StatusPending, to: runs.StatusRunning},
		{kind: "state", runID: id, from: runs.StatusRunning, to: runs.StatusFailed},
		{kind: "end", runID: id, status: runs.StatusFailed},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events = %+v\nwant     %+v", got, want)
	}
}

// A run terminalized outside the engine before Launch observed it (the
// httpapi pending-stop path) still produces an end event, so feed clients
// drop it.
func TestRunEventsEndForRunTerminalizedBeforeLaunch(t *testing.T) {
	sink := &eventSink{}
	h := newHarnessDeps(runtime.NewFakeRuntime(), sink, func() time.Time { return tapClock })
	id := h.createRun(t)
	if err := h.st.SetStatus(id, runs.StatusRunning); err != nil {
		t.Fatal(err)
	}
	if err := h.st.SetStatus(id, runs.StatusStopped); err != nil {
		t.Fatal(err)
	}
	if err := h.eng.Launch(context.Background(), id); err == nil {
		t.Fatal("Launch(terminal) error = nil")
	}
	got := sink.snapshot()
	want := []runEvent{{kind: "end", runID: id, status: runs.StatusStopped}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events = %+v, want %+v", got, want)
	}
}

// panickingEventSink proves event delivery is isolated like OnRunFinished.
type panickingEventSink struct{}

func (panickingEventSink) OnFrame(metrics.MetricsFrame) {}
func (panickingEventSink) OnRunState(runs.Run, runs.Status, runs.Status, time.Time) {
	panic("state boom")
}
func (panickingEventSink) OnRunEnd(runs.Run) { panic("end boom") }

func TestRunEventPanicDoesNotFailRun(t *testing.T) {
	h := newHarnessDeps(runtime.NewFakeRuntime(), panickingEventSink{}, func() time.Time { return tapClock })
	id := h.createRun(t)
	h.rt.SetExitCode("fake-1", 0)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	waitCallsContain(t, h, "Remove:fake-1")
	assertSemFree(t, h.sem)
}

// k6flow-variables V-T3: request env reaches the container spec, never the
// store or the logs, and can never override the reserved script key.
func TestLaunchWithEnvAddsEnvToSpec(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	const secret = "env-secret-value-91ab"
	env := map[string]string{"K6FLOW_VAR_TOKEN": secret, "K6FLOW_VAR_HOST": "h"}
	if err := h.eng.LaunchWithEnv(context.Background(), id, env); err != nil {
		t.Fatalf("LaunchWithEnv: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	specs := h.rt.Specs()
	if len(specs) != 1 {
		t.Fatalf("specs = %d, want 1", len(specs))
	}
	got := specs[0].Env
	if got["K6FLOW_VAR_TOKEN"] != secret || got["K6FLOW_VAR_HOST"] != "h" {
		t.Errorf("spec env = %v, want request env", got)
	}
	if got[runtime.ScriptEnvKey] != script {
		t.Errorf("script env = %q, want the stored script", got[runtime.ScriptEnvKey])
	}
	run, _ := h.st.Get(id)
	if strings.Contains(fmt.Sprintf("%+v", run), secret) {
		t.Error("run record holds the env value")
	}
	if strings.Contains(h.log.String(), secret) {
		t.Errorf("logs leak the env value: %s", h.log.String())
	}
	// The caller's map is not retained/mutated.
	if len(env) != 2 {
		t.Errorf("caller env mutated: %v", env)
	}
}

func TestLaunchWithEnvCannotOverrideReservedKeys(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	env := map[string]string{runtime.ScriptEnvKey: "evil()", "PATH": "/evil", "K6FLOW_VAR_OK": "ok"}
	if err := h.eng.LaunchWithEnv(context.Background(), id, env); err != nil {
		t.Fatalf("LaunchWithEnv: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	got := h.rt.Specs()[0].Env
	if got[runtime.ScriptEnvKey] != script {
		t.Errorf("reserved script key overridden: %q", got[runtime.ScriptEnvKey])
	}
	if _, ok := got["PATH"]; ok {
		t.Error("non-prefixed key reached the spec")
	}
	if got["K6FLOW_VAR_OK"] != "ok" {
		t.Errorf("prefixed key dropped: %v", got)
	}
}

func TestLaunchWithoutEnvKeepsScriptOnlyEnv(t *testing.T) {
	h := newHarness(runtime.NewFakeRuntime())
	id := h.createRun(t)
	h.rt.SetOutput("fake-1", k6Output)
	if err := h.eng.Launch(context.Background(), id); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	h.waitForStatus(t, id, runs.StatusFinished)
	if got := h.rt.Specs()[0].Env; len(got) != 1 {
		t.Errorf("spec env = %v, want only the script key", got)
	}
}
