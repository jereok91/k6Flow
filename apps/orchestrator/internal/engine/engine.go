// Package engine integrates the run lifecycle: it launches one k6 container
// per run from the stored run fields, waits for completion, parses the k6
// JSON output into the approved summary, persists the terminal status and
// guarantees container cleanup and semaphore release on every path.
// Handler wiring (startRun/stopRun → engine) is deferred to K6F2-05.
package engine

import (
	"context"
	"bufio"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"k6flow/apps/orchestrator/internal/k6sum"
	"k6flow/apps/orchestrator/internal/diagnostic"
	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// Deps are the engine's injected dependencies: the run store, the container
// runtime (Docker or fake), the run-concurrency semaphore, the k6 image taken
// from config (K6_IMAGE), the structured logger and the optional live-metrics
// seams (Sink/Now, see their docs).
type Deps struct {
	// DiagnosticTimeout is a test seam; production always defaults to 35s.
	DiagnosticTimeout time.Duration
	// DiagnosticCleanupTimeout reduces each independent cleanup budget in tests.
	DiagnosticCleanupTimeout time.Duration
	Store   *runs.Store
	Runtime runtime.ContainerRuntime
	Sem     *runtime.Semaphore
	K6Image string
	Network string
	Log     *slog.Logger
	// Sink receives the live per-window metrics frames produced by the
	// Output() tap (nil disables frames; the hub wiring is cmd/server's
	// K6F3-03 job). A sink that ALSO implements RunFinisher receives one
	// terminal notification per run that ends while the engine holds it.
	// Isolation policy: sink panics are recovered and logged — inside the
	// tap for OnFrame and inside the completion path for OnRunFinished —
	// and can never fail or corrupt a run (DECISIONES K6F3-01/K6F3-03).
	Sink metrics.FrameSink
	// Now overrides the tap's window-anchor clock (test seam); nil uses
	// time.Now. The anchor is sampled once per run when Output() is attached.
	Now func() time.Time
}

// RunFinisher is an optional extension of the injected sink contract: a
// metrics.FrameSink that also implements it receives exactly one
// OnRunFinished call for a run that reaches a terminal state while the
// engine owns its handle, so the K6F3-03 hub can close the run's
// subscribers (CloseRun(runID, 1000), parent-decided: empty reason, no
// terminal frame). It is defined HERE — the frozen internal/metrics and
// internal/live packages are untouched — and detected dynamically: a sink
// that only implements metrics.FrameSink, or a nil sink, simply never
// receives the notification (no-op).
type RunFinisher interface {
	OnRunFinished(runID string)
}

// RunEventSink is a second optional extension of the injected sink: a sink
// that implements it receives the run lifecycle events that feed the global
// runs WebSocket (`GET /ws/runs`). The engine is the single producer:
//
//   - OnRunState(run, "", run.Status) when Launch first takes ownership of a
//     run (creation: httpapi creates the run and immediately hands it to
//     Launch, so this is the creation/queued signal);
//   - OnRunState(run, pending, running) after the promotion;
//   - OnRunState(run, from, terminal) + OnRunEnd(run) when the engine
//     terminalizes a run; OnRunEnd alone when it observes a run that was
//     terminalized elsewhere (httpapi stop paths) on a path it owns.
//
// run is a store snapshot taken after the transition. Calls are synchronous
// and recover-isolated: implementations must not block (live's fan-out is
// non-blocking) and a panic never affects the run.
type RunEventSink interface {
	OnRunState(run runs.Run, from, to runs.Status, at time.Time)
	OnRunEnd(run runs.Run)
}

// VariableEnvPrefix is the only env namespace a run request may inject into
// the k6 container (secret variables, `__ENV["K6FLOW_VAR_<NAME>"]`). It is
// disjoint from runtime.ScriptEnvKey, so user env cannot replace the script.
const VariableEnvPrefix = "K6FLOW_VAR_"

// Engine owns in-flight launches keyed by run id; the handle map is the
// double-launch guard and the Stop rendezvous point.
type Engine struct {
	store   *runs.Store
	rt      runtime.ContainerRuntime
	sem     *runtime.Semaphore
	image   string
	network string
	log     *slog.Logger
	sink    metrics.FrameSink
	nowFn   func() time.Time
	diagnosticTimeout time.Duration
	diagnosticCleanupTimeout time.Duration

	mu      sync.Mutex
	handles map[string]*handle
}

// handle tracks one in-flight launch: the container id (set after Create)
// and the stop-request flag, both mutex-guarded so Stop and the launch path
// race safely.
type handle struct {
	mu          sync.Mutex
	containerID string
	stopReq     bool
	cancel context.CancelFunc
}

func (h *handle) setContainer(id string) { h.mu.Lock(); h.containerID = id; h.mu.Unlock() }

func (h *handle) container() string { h.mu.Lock(); defer h.mu.Unlock(); return h.containerID }

func (h *handle) stopRequested() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.stopReq }

// requestStop marks the run as stop-requested and returns the known
// container id (empty while Create has not returned yet).
func (h *handle) requestStop() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopReq = true
	if h.cancel != nil { h.cancel() }
	return h.containerID
}

// New builds an Engine from the injected deps; a nil logger falls back to
// slog.Default.
func New(d Deps) *Engine {
	logger := d.Log
	if logger == nil {
		logger = slog.Default()
	}
	timeout := d.DiagnosticTimeout
	if timeout <= 0 || timeout > 35*time.Second {
		timeout = 35 * time.Second
	}
	cleanupTimeout := d.DiagnosticCleanupTimeout
	if cleanupTimeout <= 0 || cleanupTimeout > 5*time.Second {
		cleanupTimeout = 5 * time.Second
	}
	return &Engine{
		diagnosticCleanupTimeout: cleanupTimeout,
		diagnosticTimeout: timeout,
		store:   d.Store,
		rt:      d.Runtime,
		sem:     d.Sem,
		image:   d.K6Image,
		network: d.Network,
		log:     logger,
		sink:    d.Sink,
		nowFn:   d.Now,
		handles: map[string]*handle{},
	}
}

// Launch validates the run, takes a semaphore slot, promotes pending →
// running, creates and starts the container, attaches the Output() tap
// exactly once (single consumer: live frames out, raw bytes to the summary
// pipe), then finalizes asynchronously: Wait → join tap → outcome mapping →
// terminal SetStatus + SetSummary → guaranteed cleanup → semaphore release.
// Early errors (validation, context, acquisition) change no status; failures
// after promotion terminalize the run as failed. Launch returns once the
// container has started.
func (e *Engine) Launch(ctx context.Context, runID string) error {
	return e.LaunchWithEnv(ctx, runID, nil)
}

// LaunchWithEnv is Launch plus per-run container env (k6flow-variables
// V-T3: secret variables as K6FLOW_VAR_* entries). env lives only in this
// call: it is copied into the container spec, never stored in the run record
// and never logged. Keys outside the VariableEnvPrefix namespace are dropped,
// so env can never override the reserved script key or any other runtime
// env (the HTTP layer already rejects them; this is defense in depth).
func (e *Engine) LaunchWithEnv(ctx context.Context, runID string, env map[string]string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("engine: launch %s: %w", runID, err)
	}
	run, ok := e.store.Get(runID)
	if !ok {
		return fmt.Errorf("engine: launch: unknown run %q", runID)
	}
	if isTerminal(run.Status) {
		// Terminalized before Launch ran (httpapi pending stop): the feed
		// must still learn the run ended.
		e.emitEnd(run)
		return fmt.Errorf("engine: launch: run %s is terminal (%s)", runID, run.Status)
	}
	h := &handle{}
	e.mu.Lock()
	if _, exists := e.handles[runID]; exists {
		e.mu.Unlock()
		return fmt.Errorf("engine: launch: run %s already launched", runID)
	}
	e.handles[runID] = h
	e.mu.Unlock()
	// Creation signal for the global runs feed (before any capacity wait so
	// runs waiting for a slot are visible).
	e.emitState(run, "", run.Status, run.CreatedAt)

	if err := e.sem.Acquire(ctx); err != nil {
		e.deregister(runID)
		return fmt.Errorf("engine: launch %s: %w", runID, err)
	}
	if run.Status == runs.StatusPending {
		if err := e.store.SetStatus(runID, runs.StatusRunning); err != nil {
			// Typically a stop terminalized the pending run while Launch
			// waited: surface it as ended so feed clients drop it.
			if cur, ok := e.store.Get(runID); ok && isTerminal(cur.Status) {
				e.emitEnd(cur)
			}
			e.sem.Release()
			e.deregister(runID)
			return fmt.Errorf("engine: launch %s: %w", runID, err)
		}
		if cur, ok := e.store.Get(runID); ok {
			at := time.Now()
			if cur.StartedAt != nil {
				at = *cur.StartedAt
			}
			e.emitState(cur, runs.StatusPending, runs.StatusRunning, at)
		}
	}
	e.log.Info("run launch requested", "runId", runID, "image", e.image)

	containerID, err := e.rt.Create(ctx, e.spec(run, env))
	if err != nil {
		e.failLaunch(runID, "create", err)
		return fmt.Errorf("engine: launch %s: create: %w", runID, err)
	}
	h.setContainer(containerID)
	if err := e.rt.Start(ctx, containerID); err != nil {
		e.cleanup(context.WithoutCancel(ctx), containerID)
		e.failLaunch(runID, "start", err)
		return fmt.Errorf("engine: launch %s: start: %w", runID, err)
	}
	completionCtx := context.WithoutCancel(ctx)
	var cancel context.CancelFunc
	if run.Mode == "diagnostic" {
		completionCtx, cancel = context.WithTimeout(completionCtx, e.diagnosticTimeout)
		h.mu.Lock()
		h.cancel = cancel
		if h.stopReq {
			cancel()
		}
		h.mu.Unlock()
		// The independent deadline starts immediately after Start, not after
		// Output attaches or Wait returns. It also covers output joining.
		go func() {
			<-completionCtx.Done()
			if cur, ok := e.store.Get(runID); !ok || (cur.Status.IsTerminal() && cur.Status != runs.StatusStopped) {
				return
			}
			h.requestStop()
			stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer stopCancel()
			_ = e.rt.Stop(stopCtx, containerID, -time.Nanosecond)
		}()
	}
	if h.stopRequested() {
		// Stop raced the create/start window (flag set before the container
		// id was known): now that it is running, ask it to exit so Wait
		// returns and the completion path finalizes as stopped.
		stopCtx := context.WithoutCancel(ctx)
		timeout := time.Duration(0)
		if run.Mode == "diagnostic" {
			stopCtx = completionCtx
			timeout = -time.Nanosecond
		}
		if err := e.rt.Stop(stopCtx, containerID, timeout); err != nil {
			e.log.Warn("stop after start failed", "runId", runID, "container", containerID, "error", err)
		}
	}
	// The tap attaches Output() exactly once, right after the container is
	// running, so windows stream while the run is live; the anchor defines
	// run-relative window 0. A detached context keeps caller cancellation
	// from tearing the log stream down.
	tap := e.startTap(completionCtx, runID, containerID)
	// Detached: completion/cleanup must survive cancellation of the caller's
	// context (guaranteed removal).
	go func() {
		if cancel != nil {
			defer cancel()
		}
		e.complete(completionCtx, runID, h, tap)
	}()
	return nil
}

// Stop requests a graceful container stop so the completion path finalizes
// the run as stopped (an explicit stop overrides the exit-code mapping).
// Unknown run ids are errors; terminal runs and runs the engine never
// launched are documented no-ops — terminal immutability is the store's.
func (e *Engine) Stop(ctx context.Context, runID string) error {
	h := e.handleFor(runID)
	if h == nil {
		if _, ok := e.store.Get(runID); !ok {
			return fmt.Errorf("engine: stop: unknown run %q", runID)
		}
		return nil
	}
	containerID := h.requestStop()
	e.log.Info("run stop requested", "runId", runID)
	if containerID == "" {
		return nil // launch path observes the flag once Create returns
	}
	timeout := time.Duration(0)
	if run, ok := e.store.Get(runID); ok && run.Mode == "diagnostic" {
		timeout = -time.Nanosecond
	}
	if err := e.rt.Stop(ctx, containerID, timeout); err != nil {
		// A concurrent completion may already have removed the container;
		// terminal runs stay a no-op instead of surfacing the stale error.
		if run, ok := e.store.Get(runID); ok && isTerminal(run.Status) {
			return nil
		}
		return fmt.Errorf("engine: stop %s: %w", runID, err)
	}
	return nil
}

// complete is the terminalization goroutine: wait for the container, join
// the Output() tap (its parse outcome replaces the former inline Output
// read; on a wait error the log stream is force-closed so the tap can never
// block completion), then decide, persist and always cleanup (Stop→Remove
// with force on the detached context), release the semaphore and deregister
// the handle — including parse-failure paths, where the parse failure itself
// marks the run failed.
func (e *Engine) complete(ctx context.Context, runID string, h *handle, t *tap) {
	containerID := h.container()
	defer e.deregister(runID)
	defer e.sem.Release()
	defer func() {
		if _, bounded := ctx.Deadline(); bounded {
			e.cleanupDiagnostic(ctx, runID, containerID)
		} else {
			e.cleanup(ctx, containerID)
		}
	}()

	var exit int
	var waitErr error
	var parsed runs.Summary
	var parseErr error
	if _, bounded := ctx.Deadline(); bounded {
		type result struct {
			exit int
			err error
		}
		waited := make(chan result, 1)
		go func() {
			code, err := e.rt.Wait(ctx, containerID)
			waited <- result{code, err}
		}()
		select {
		case result := <-waited:
			exit, waitErr = result.exit, result.err
		case <-ctx.Done():
			waitErr = ctx.Err()
		}
		if waitErr != nil {
			go t.closeOutput()
		}
		joined := make(chan struct{})
		go func() {
			t.wait()
			close(joined)
		}()
		select {
		case <-joined:
			parsed, parseErr = t.summary, t.parseErr
		case <-ctx.Done():
			h.requestStop()
			go t.closeOutput()
			parseErr = ctx.Err()
		}
	} else {
		exit, waitErr = e.rt.Wait(ctx, containerID)
		if waitErr != nil {
			t.closeOutput()
		}
		t.wait()
		parsed, parseErr = t.summary, t.parseErr
	}
	// Seal frame admission without waiting on callbacks. A callback already
	// admitted may drain later, but final sink notification must follow it.
	if t.delivery != nil {
		t.delivery.seal()
	}
	// Serialize stop disposition with the terminal store transition.
	h.mu.Lock()
	if ctx.Err() != nil {
		h.stopReq = true
	}
	status, summary := e.decide(runID, exit, waitErr, h.stopReq, parsed, parseErr)
	if exit != 0 || waitErr != nil || parseErr != nil {
		if run, ok := e.store.Get(runID); ok && run.Trace != nil {
			events := run.Trace.Events
			if len(events) > 0 && events[len(events)-1].Outcome == "success" {
				e.store.InvalidateDiagnostic(runID)
			}
		}
	}
	from := e.currentStatus(runID)
	statusErr := e.store.SetStatus(runID, status)
	h.mu.Unlock()
	if err := statusErr; err != nil {
		// Terminal immutability: if the run already reached a terminal state
		// (e.g. a stop landed first), the transition is rejected and no
		// summary is stored; the condition is logged, never retried. The run
		// IS terminal in the store, so the terminal notification still fires
		// (exactly once: no other completion path exists for this launch).
		e.log.Error("run final status rejected", "runId", runID, "status", string(status), "error", err)
		if cur, ok := e.store.Get(runID); ok && isTerminal(cur.Status) {
			e.emitEnd(cur)
		}
		e.finishTap(runID, t)
		return
	}
	if summary != nil {
		if err := e.store.SetSummary(runID, summary); err != nil {
			e.log.Error("run summary persist failed", "runId", runID, "error", err)
		}
	}
	e.emitTerminal(runID, from)
	// Terminal notification, K6F3-03 — exact ordering: EVERY terminal path
	// (finished, failed — crash, wait or parse error — and stopped) passes
	// this point exactly once, AFTER the tap has been joined (or the diagnostic
	// deadline has sealed its trace and frame admission). Diagnostic sink finish
	// waits asynchronously for admitted callbacks; cleanup never waits for it.
	// Normally t.wait()
	// ⇒ every OnFrame for every closed window already reached the sink; the
	// trailing partial window never emits, so no frame can follow the
	// notification) and AFTER the terminal SetStatus + SetSummary are
	// persisted. For load, notification still precedes deferred cleanup,
	// semaphore release and handle deregistration. For diagnostic, notification
	// can follow cleanup if a previously admitted callback is still draining;
	// neither resource cleanup nor terminal snapshots wait for that callback.
	e.finishTap(runID, t)
	if waitErr != nil {
		e.log.Info("run finalized", "runId", runID, "status", string(status), "wait_error", waitErr)
		return
	}
	e.log.Info("run finalized", "runId", runID, "status", string(status), "exit_code", exit)
}

// notifyRunFinished delivers the optional terminal notification (see
// RunFinisher): nil sink or a sink without OnRunFinished is a no-op. The
// call carries the tap's recover-isolation policy (DECISIONES K6F3-01) — a
// panicking hub is logged and can never abort the completion or
// launch-failure path that owns cleanup, the semaphore and deregistration.
func (e *Engine) notifyRunFinished(runID string) {
	if e.sink == nil {
		return
	}
	finisher, ok := e.sink.(RunFinisher)
	if !ok {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			e.log.Warn("run-finished notification panic recovered; run unaffected", "runId", runID, "panic", r)
		}
	}()
	finisher.OnRunFinished(runID)
}

// currentStatus reads the stored status (empty for unknown runs).
func (e *Engine) currentStatus(runID string) runs.Status {
	if run, ok := e.store.Get(runID); ok {
		return run.Status
	}
	return ""
}

// emitTerminal publishes the engine-applied terminal transition followed by
// the end event, from a fresh store snapshot.
func (e *Engine) emitTerminal(runID string, from runs.Status) {
	cur, ok := e.store.Get(runID)
	if !ok {
		return
	}
	at := time.Now()
	if cur.FinishedAt != nil {
		at = *cur.FinishedAt
	}
	e.emitState(cur, from, cur.Status, at)
	e.emitEnd(cur)
}

// eventSink returns the optional RunEventSink (nil when absent).
func (e *Engine) eventSink() RunEventSink {
	if e.sink == nil {
		return nil
	}
	sink, _ := e.sink.(RunEventSink)
	return sink
}

// emitState delivers OnRunState with the tap's recover-isolation policy.
func (e *Engine) emitState(run runs.Run, from, to runs.Status, at time.Time) {
	sink := e.eventSink()
	if sink == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			e.log.Warn("run-state event panic recovered; run unaffected", "runId", run.ID, "panic", r)
		}
	}()
	sink.OnRunState(run, from, to, at)
}

// emitEnd delivers OnRunEnd with the tap's recover-isolation policy.
func (e *Engine) emitEnd(run runs.Run) {
	sink := e.eventSink()
	if sink == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			e.log.Warn("run-end event panic recovered; run unaffected", "runId", run.ID, "panic", r)
		}
	}()
	sink.OnRunEnd(run)
}

// decide maps the wait result to the terminal status and its summary using
// the tap's parse outcome (identical semantics to the former e.parse call).
// Precedence: an explicit stop request wins over the exit-code mapping; a
// wait error or a mapped failure yields failed with no summary; a finished
// run uses the tap-parsed output, and a parse/output failure downgrades it to
// failed with no summary. Stopped runs tolerate parse failures (a killed
// container may truncate the stream) and fall back to an all-zero summary so
// the terminal-summary invariant holds for stopped runs.
func (e *Engine) decide(runID string, exit int, waitErr error, stopped bool, summary runs.Summary, parseErr error) (runs.Status, *runs.Summary) {
	if stopped {
		if parseErr != nil {
			e.log.Warn("output parse failed for stopped run; storing zero summary", "runId", runID, "error", parseErr)
			return runs.StatusStopped, &runs.Summary{}
		}
		return runs.StatusStopped, &summary
	}
	if waitErr != nil {
		e.log.Error("container wait failed", "runId", runID, "error", waitErr)
		return runs.StatusFailed, nil
	}
	status, passed := k6sum.OutcomeForExit(exit)
	if status == runs.StatusFailed {
		e.log.Warn("run failed by exit code", "runId", runID, "exit_code", exit)
		return runs.StatusFailed, nil
	}
	if parseErr != nil {
		e.log.Error("output parse failed; run marked failed", "runId", runID, "error", parseErr)
		return runs.StatusFailed, nil
	}
	summary.ThresholdsPassed = passed
	return status, &summary
}

// frameDelivery is a per-diagnostic-run admission gate. The admission decision
// and seal share a lock; arbitrary sink code runs outside that lock. Thus seal
// stays bounded even if a callback never returns. No callback admitted after
// seal reaches the sink, and the drained channel orders finish after all those
// admitted earlier (including callbacks that panic).
type frameDelivery struct {
	log *slog.Logger
	sink metrics.FrameSink
	mu sync.Mutex
	sealed bool
	active int
	drained chan struct{}
}

func (d *frameDelivery) OnFrame(frame metrics.MetricsFrame) {
	d.mu.Lock()
	if d.sealed {
		d.mu.Unlock()
		return
	}
	d.active++
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		d.active--
		if d.sealed && d.active == 0 {
			close(d.drained)
		}
		d.mu.Unlock()
	}()
	// Contain at invocation, preserving aggregator progress and hiding payloads.
	defer func() {
		if recover() != nil {
			logger := d.log
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn("diagnostic frame callback panic recovered; run unaffected")
		}
	}()
	d.sink.OnFrame(frame)
}

func (d *frameDelivery) seal() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sealed {
		return
	}
	d.sealed = true
	if d.active == 0 {
		close(d.drained)
	}
}

// finishTap decouples diagnostic delivery ordering from resource lifecycle.
// A permanently blocked OnFrame delays the final sink notification forever;
// terminal snapshots, watchdog shutdown and cleanup are still independent.
func (e *Engine) finishTap(runID string, t *tap) {
	if t.delivery == nil {
		e.notifyRunFinished(runID)
		return
	}
	t.delivery.seal()
	go func() {
		<-t.delivery.drained
		e.notifyRunFinished(runID)
	}()
}

// tap is the single-consumer view of one run's Output stream, summary pipe,
// aggregator and optional diagnostic delivery gate. Summary/parseErr are read
// only after wait; a diagnostic deadline can instead seal delivery and finish
// the resource lifecycle without reading those still-mutating fields.
type tap struct {
	delivery *frameDelivery
	wg       sync.WaitGroup
	summary  runs.Summary
	parseErr error
	closeOut func()
}

func (t *tap) wait() { t.wg.Wait() }
func (t *tap) closeOutput() {
	if t.closeOut != nil {
		t.closeOut()
	}
}

// startTap attaches Output() exactly once for this run. A failed attach
// records the error as the parse failure (same terminal effect as the
// pre-tap flow: failed run, or zero summary for stopped runs). On success two
// goroutines run: k6sum.Parse draining the pipe, and the pump consuming
// Output().
func (e *Engine) startTap(ctx context.Context, runID, containerID string) *tap {
	t := &tap{}
	sink := e.sink
	if _, diagnostic := ctx.Deadline(); diagnostic && sink != nil {
		t.delivery = &frameDelivery{log: e.log, sink: sink, drained: make(chan struct{})}
		sink = t.delivery
	}
	reader, err := e.output(ctx, containerID)
	if err != nil {
		t.parseErr = err
		return t
	}
	t.closeOut = sync.OnceFunc(func() { _ = reader.Close() })
	pr, pw := io.Pipe()
	now := time.Now
	if e.nowFn != nil {
		now = e.nowFn
	}
	agg := metrics.NewRunWindowAggregator(runID, now(), sink)
	
	// Create and wire the EndpointsTracker for per-endpoint metrics
	endpointsTracker := metrics.NewEndpointsTracker(20)
	agg.SetEndpointsTracker(endpointsTracker)
	e.store.SetEndpoints(runID, endpointsTracker)
	
	t.wg.Add(2)
	go func() {
		defer t.wg.Done()
		summary, err := k6sum.Parse(pr)
		t.summary, t.parseErr = summary, err
		// Fail-fast plumbing: after an early parse abort (malformed line) any
		// pending or future pump write must error out instead of blocking.
		_ = pr.CloseWithError(err)
	}()
	go func() {
		defer t.wg.Done()
		defer t.closeOut()
		if run, ok := e.store.Get(runID); ok && run.Mode == "diagnostic" {
			e.pumpDiagnostic(agg, runID, reader, pw)
		} else {
			e.pump(agg, runID, reader, pw)
		}
	}()
	return t
}

// output bounds attachment independently of SDK cooperation. A late reader is
// closed by the attachment goroutine and can never become a second consumer.
func (e *Engine) output(ctx context.Context, containerID string) (io.ReadCloser, error) {
	if _, bounded := ctx.Deadline(); !bounded {
		return e.rt.Output(ctx, containerID)
	}
	type result struct {
		reader io.ReadCloser
		err error
	}
	attached := make(chan result)
	go func() {
		reader, err := e.rt.Output(ctx, containerID)
		select {
		case attached <- result{reader, err}:
		case <-ctx.Done():
			if reader != nil {
				_ = reader.Close()
			}
		}
	}()
	select {
	case result := <-attached:
		return result.reader, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// pump is the run's only Output() reader. Every byte is forwarded to the
// summary pipe untouched — k6sum observes the identical stream (same bytes,
// same read errors, oversized lines included), so its fail-the-summary
// semantics stay byte-compatible. Complete lines are also fed to the window
// aggregator, whose failures never reach this path (forwardLine recovers
// panics per line). Memory bound: a 32 KiB read buffer plus a line
// accumulator capped at k6sum.MaxLineBytes (oversized lines are dropped from
// aggregation only).
func (e *Engine) pump(agg *metrics.RunWindowAggregator, runID string, reader io.Reader, pw *io.PipeWriter) {
	buf := make([]byte, 32*1024)
	var line []byte
	discarding := false
	for {
		n, rerr := reader.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			line, discarding = feedLines(agg, runID, e.log, chunk, line, discarding)
			if _, werr := pw.Write(chunk); werr != nil {
				// k6sum aborted (e.g. malformed line): stop consuming — the
				// summary path fails exactly as it would without the tap.
				return
			}
		}
		if rerr != nil {
			// k6sum scans a final line even without a trailing newline; feed
			// the residual so the aggregator matches that behavior.
			if !discarding && len(line) > 0 {
				forwardLine(agg, runID, e.log, line)
			}
			if errors.Is(rerr, io.EOF) {
				_ = pw.Close()
			} else {
				// Same wrapped read error k6sum would report reading Output
				// directly ("k6sum: read stream: ...").
				_ = pw.CloseWithError(rerr)
			}
			return
		}
	}
}

// pumpDiagnostic is still the sole Output consumer. Custom points are consumed
// by the closed trace parser, not forwarded to summaries or native aggregators.
// Oversized lines are discarded in bounded pieces and invalidate the trace.
func (e *Engine) pumpDiagnostic(agg *metrics.RunWindowAggregator, runID string, reader io.Reader, pw *io.PipeWriter) {
	buffered := bufio.NewReaderSize(reader, 32*1024)
	var line []byte
	oversized := false
	for {
		part, err := buffered.ReadSlice('\n')
		if !oversized {
			if len(line)+len(part) > k6sum.MaxLineBytes {
				e.store.InvalidateDiagnostic(runID)
				line = line[:0]
				oversized = true
			} else {
				line = append(line, part...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if run, ok := e.store.Get(runID); !ok || run.Status.IsTerminal() {
			_ = pw.Close()
			return
		}
		if !oversized && len(line) > 0 && !e.store.DiagnosticLine(runID, line) {
			forwardLine(agg, runID, e.log, line)
			if _, writeErr := pw.Write(line); writeErr != nil {
				return
			}
		}
		line = line[:0]
		oversized = false
		if err != nil {
			if errors.Is(err, io.EOF) {
				_ = pw.Close()
			} else {
				_ = pw.CloseWithError(err)
			}
			return
		}
	}
}

// feedLines splits chunk into newline-terminated lines for the aggregator,
// enforcing the 1 MiB guard: bytes accumulated past k6sum.MaxLineBytes are
// dropped from aggregation until the next newline (the raw bytes still
// reach k6sum). Returns the residual line buffer and the discard state.
func feedLines(agg *metrics.RunWindowAggregator, runID string, log *slog.Logger, chunk, line []byte, discarding bool) ([]byte, bool) {
	for _, b := range chunk {
		if b == '\n' {
			if !discarding {
				forwardLine(agg, runID, log, line)
			}
			line = line[:0]
			discarding = false
			continue
		}
		if discarding {
			continue
		}
		if len(line) >= k6sum.MaxLineBytes {
			discarding = true
			line = line[:0]
			continue
		}
		line = append(line, b)
	}
	return line, discarding
}

// forwardLine isolates the broadcast path: a panicking aggregator or sink is
// recovered and logged, never propagated, so aggregation failures cannot
// corrupt or fail the summary path — the deliberate divergence from
// k6sum's fail-the-summary policy (DECISIONES K6F3-01).
func forwardLine(agg *metrics.RunWindowAggregator, runID string, log *slog.Logger, line []byte) {
	if len(line) == 0 {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Warn("metrics aggregation panic recovered; run unaffected", "runId", runID, "panic", r)
		}
	}()
	agg.OnLine(line)
}

// spec builds the container spec from the stored run fields: the script via
// the reserved env key (stripped before container create by the runtime),
// `run --out json` with REST VUs/duration overriding script options, the
// run-id label and the contract limits, plus the request env restricted to
// VariableEnvPrefix keys. Spec contents are never logged.
func (e *Engine) spec(run runs.Run, extra map[string]string) runtime.Spec {
	env := make(map[string]string, len(extra)+1)
	for key, value := range extra {
		if strings.HasPrefix(key, VariableEnvPrefix) {
			env[key] = value
		}
	}
	env[runtime.ScriptEnvKey] = run.Script
	args := []string{"--out", "json", "--vus", strconv.Itoa(run.VUs), "--duration", strconv.FormatInt(int64(run.DurationMs), 10) + "ms", runtime.ScriptPath}
	var entry []byte
	if run.Mode == "diagnostic" {
		entry = []byte(diagnostic.Entry)
		args = []string{"--out", "json", "--vus", "1", "--iterations", "1", "--system-tags", "", runtime.DiagnosticPath}
		// Reserved K6_* execution options never enter the container: only
		// K6FLOW_VAR_* was copied above. Script options are not re-exported.
	}
	return runtime.Spec{
		DiagnosticEntry: entry,
		Image:   e.image,
		Network: e.network,
		Command: []string{"run"},
		Args: args,
		Env:       env,
		Labels:    map[string]string{runtime.LabelRunID: run.ID},
		CPUMillis: run.CPUMillis,
		MemoryMiB: run.MemoryMiB,
	}
}

// failLaunch terminalizes a run whose launch failed after the pending →
// running promotion (no container is left running), notifies the terminal
// sink (no completion goroutine exists on this path, so complete() can never
// duplicate it), frees the semaphore slot and drops the handle so the run
// can never be re-launched or leak a slot.
func (e *Engine) failLaunch(runID, stage string, err error) {
	e.log.Error("run launch failed", "runId", runID, "stage", stage, "error", err)
	from := e.currentStatus(runID)
	if statusErr := e.store.SetStatus(runID, runs.StatusFailed); statusErr != nil {
		// A rejection means the run is already terminal (store immutability);
		// either way the run ended while the engine held its handle, so the
		// exactly-once notification still fires — before the slot release and
		// deregistration below (ordering mirrors complete(): after the
		// terminal transition, before the path's cleanup duties).
		e.log.Error("launch failure transition failed", "runId", runID, "error", statusErr)
		if cur, ok := e.store.Get(runID); ok && isTerminal(cur.Status) {
			e.emitEnd(cur)
		}
	} else {
		e.emitTerminal(runID, from)
	}
	e.notifyRunFinished(runID)
	e.sem.Release()
	e.deregister(runID)
}

// cleanupDiagnostic gives each operation its own fresh deadline. In particular,
// a slow Stop cannot spend Remove's budget. Failure logs contain lifecycle
// metadata only: arbitrary runtime errors might include submitted content.
func (e *Engine) cleanupDiagnostic(ctx context.Context, runID, containerID string) {
	base := context.WithoutCancel(ctx)
	stopCtx, stopCancel := context.WithTimeout(base, e.diagnosticCleanupTimeout)
	if err := e.rt.Stop(stopCtx, containerID, -time.Nanosecond); err != nil {
		e.log.Warn("diagnostic cleanup stop failed", "runId", runID, "container", containerID, "deadlineExceeded", stopCtx.Err() == context.DeadlineExceeded)
	}
	stopCancel()

	removeCtx, removeCancel := context.WithTimeout(base, e.diagnosticCleanupTimeout)
	defer removeCancel()
	if err := e.rt.Remove(removeCtx, containerID, true); err != nil {
		e.log.Warn("diagnostic cleanup remove failed", "runId", runID, "container", containerID, "deadlineExceeded", removeCtx.Err() == context.DeadlineExceeded)
	}
}

// cleanup guarantees removal: best-effort Stop, then forced Remove on a
// cancel-free context — always attempted, even when an earlier step failed.
func (e *Engine) cleanup(ctx context.Context, containerID string) {
	if err := e.rt.Stop(ctx, containerID, 0); err != nil {
		e.log.Warn("cleanup stop failed", "container", containerID, "error", err)
	}
	if err := e.rt.Remove(ctx, containerID, true); err != nil {
		e.log.Warn("cleanup remove failed", "container", containerID, "error", err)
	}
}

func (e *Engine) handleFor(runID string) *handle {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.handles[runID]
}

func (e *Engine) deregister(runID string) {
	e.mu.Lock()
	delete(e.handles, runID)
	e.mu.Unlock()
}

// isTerminal reports membership in the closed terminal set (mirrors the
// store's transition table: terminal states have no outgoing moves).
func isTerminal(status runs.Status) bool {
	return status == runs.StatusFinished || status == runs.StatusFailed || status == runs.StatusStopped
}
