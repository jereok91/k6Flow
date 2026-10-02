package engine_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"k6flow/apps/orchestrator/internal/engine"
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

	// Full lifecycle ordering: create, start, wait, parse, cleanup Stop→Remove.
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Wait:fake-1", "Output:fake-1", "Stop:fake-1", "Remove:fake-1")
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
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Wait:fake-1", "Stop:fake-1", "Remove:fake-1")
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
	h.assertCalls(t, "Create:fake-1", "Start:fake-1", "Wait:fake-1", "Output:fake-1", "Stop:fake-1", "Remove:fake-1")
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
	// Stop reached the runtime before the completion path's cleanup.
	calls := rt.Calls()
	if len(calls) < 2 || calls[2] != "Stop:fake-1" {
		t.Errorf("calls = %v, want Stop:fake-1 after Wait blocks", calls)
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
