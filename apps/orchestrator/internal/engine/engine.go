// Package engine integrates the run lifecycle: it launches one k6 container
// per run from the stored run fields, waits for completion, parses the k6
// JSON output into the approved summary, persists the terminal status and
// guarantees container cleanup and semaphore release on every path.
// Handler wiring (startRun/stopRun → engine) is deferred to K6F2-05.
package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"k6flow/apps/orchestrator/internal/k6sum"
	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// Deps are the engine's injected dependencies: the run store, the container
// runtime (Docker or fake), the run-concurrency semaphore, the k6 image taken
// from config (K6_IMAGE), the structured logger and the optional live-metrics
// seams (Sink/Now, see their docs).
type Deps struct {
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
	return h.containerID
}

// New builds an Engine from the injected deps; a nil logger falls back to
// slog.Default.
func New(d Deps) *Engine {
	logger := d.Log
	if logger == nil {
		logger = slog.Default()
	}
	return &Engine{
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
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("engine: launch %s: %w", runID, err)
	}
	run, ok := e.store.Get(runID)
	if !ok {
		return fmt.Errorf("engine: launch: unknown run %q", runID)
	}
	if isTerminal(run.Status) {
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

	if err := e.sem.Acquire(ctx); err != nil {
		e.deregister(runID)
		return fmt.Errorf("engine: launch %s: %w", runID, err)
	}
	if run.Status == runs.StatusPending {
		if err := e.store.SetStatus(runID, runs.StatusRunning); err != nil {
			e.sem.Release()
			e.deregister(runID)
			return fmt.Errorf("engine: launch %s: %w", runID, err)
		}
	}
	e.log.Info("run launch requested", "runId", runID, "image", e.image)

	containerID, err := e.rt.Create(ctx, e.spec(run))
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
	if h.stopRequested() {
		// Stop raced the create/start window (flag set before the container
		// id was known): now that it is running, ask it to exit so Wait
		// returns and the completion path finalizes as stopped.
		if err := e.rt.Stop(context.WithoutCancel(ctx), containerID, 0); err != nil {
			e.log.Warn("stop after start failed", "runId", runID, "container", containerID, "error", err)
		}
	}
	// The tap attaches Output() exactly once, right after the container is
	// running, so windows stream while the run is live; the anchor defines
	// run-relative window 0. A detached context keeps caller cancellation
	// from tearing the log stream down.
	tap := e.startTap(context.WithoutCancel(ctx), runID, containerID)
	// Detached: completion/cleanup must survive cancellation of the caller's
	// context (guaranteed removal).
	go e.complete(context.WithoutCancel(ctx), runID, h, tap)
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
	if err := e.rt.Stop(ctx, containerID, 0); err != nil {
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
	defer e.cleanup(ctx, containerID)

	exit, waitErr := e.rt.Wait(ctx, containerID)
	if waitErr != nil {
		t.closeOutput()
	}
	t.wait()
	status, summary := e.decide(runID, exit, waitErr, h.stopRequested(), t.summary, t.parseErr)
	if err := e.store.SetStatus(runID, status); err != nil {
		// Terminal immutability: if the run already reached a terminal state
		// (e.g. a stop landed first), the transition is rejected and no
		// summary is stored; the condition is logged, never retried. The run
		// IS terminal in the store, so the terminal notification still fires
		// (exactly once: no other completion path exists for this launch).
		e.log.Error("run final status rejected", "runId", runID, "status", string(status), "error", err)
		e.notifyRunFinished(runID)
		return
	}
	if summary != nil {
		if err := e.store.SetSummary(runID, summary); err != nil {
			e.log.Error("run summary persist failed", "runId", runID, "error", err)
		}
	}
	// Terminal notification, K6F3-03 — exact ordering: EVERY terminal path
	// (finished, failed — crash, wait or parse error — and stopped) passes
	// this point exactly once, AFTER the tap has been joined (t.wait() above
	// ⇒ every OnFrame for every closed window already reached the sink; the
	// trailing partial window never emits, so no frame can follow the
	// notification) and AFTER the terminal SetStatus + SetSummary are
	// persisted, but BEFORE the deferred Cleanup (Stop→Remove), semaphore
	// release and handle deregistration — subscribers get close 1000 while
	// the store already shows the terminal state, and a slow container
	// removal can never delay or skip it.
	e.notifyRunFinished(runID)
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

// tap is the single-consumer view of one run's Output() stream. It owns the
// io.Pipe that feeds k6sum (raw bytes forward, so the summary sees the very
// same stream a direct read would deliver) and the per-run window aggregator
// that feeds the optional FrameSink. Started once in Launch, joined once in
// complete; its summary/parseErr are read only after wait().
type tap struct {
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
	reader, err := e.rt.Output(ctx, containerID)
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
	agg := metrics.NewRunWindowAggregator(runID, now(), e.sink)
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
		e.pump(agg, runID, reader, pw)
	}()
	return t
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
// run-id label and the contract limits. Spec contents are never logged.
func (e *Engine) spec(run runs.Run) runtime.Spec {
	return runtime.Spec{
		Image:   e.image,
		Network: e.network,
		Command: []string{"run"},
		Args: []string{
			"--out", "json",
			"--vus", strconv.Itoa(run.VUs),
			"--duration", strconv.FormatInt(int64(run.DurationMs), 10) + "ms",
			runtime.ScriptPath,
		},
		Env:       map[string]string{runtime.ScriptEnvKey: run.Script},
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
	if statusErr := e.store.SetStatus(runID, runs.StatusFailed); statusErr != nil {
		// A rejection means the run is already terminal (store immutability);
		// either way the run ended while the engine held its handle, so the
		// exactly-once notification still fires — before the slot release and
		// deregistration below (ordering mirrors complete(): after the
		// terminal transition, before the path's cleanup duties).
		e.log.Error("launch failure transition failed", "runId", runID, "error", statusErr)
	}
	e.notifyRunFinished(runID)
	e.sem.Release()
	e.deregister(runID)
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
