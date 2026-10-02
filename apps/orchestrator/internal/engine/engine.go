// Package engine integrates the run lifecycle: it launches one k6 container
// per run from the stored run fields, waits for completion, parses the k6
// JSON output into the approved summary, persists the terminal status and
// guarantees container cleanup and semaphore release on every path.
// Handler wiring (startRun/stopRun → engine) is deferred to K6F2-05.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"sync"

	"k6flow/apps/orchestrator/internal/k6sum"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// Deps are the engine's injected dependencies: the run store, the container
// runtime (Docker or fake), the run-concurrency semaphore, the k6 image taken
// from config (K6_IMAGE) and the structured logger.
type Deps struct {
	Store   *runs.Store
	Runtime runtime.ContainerRuntime
	Sem     *runtime.Semaphore
	K6Image string
	Log     *slog.Logger
}

// Engine owns in-flight launches keyed by run id; the handle map is the
// double-launch guard and the Stop rendezvous point.
type Engine struct {
	store *runs.Store
	rt    runtime.ContainerRuntime
	sem   *runtime.Semaphore
	image string
	log   *slog.Logger

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
		log:     logger,
		handles: map[string]*handle{},
	}
}

// Launch validates the run, takes a semaphore slot, promotes pending →
// running, creates and starts the container, then finalizes asynchronously:
// Wait → outcome mapping → parse Output → terminal SetStatus + SetSummary →
// guaranteed cleanup → semaphore release. Early errors (validation, context,
// acquisition) change no status; failures after promotion terminalize the run
// as failed. Launch returns once the container has started.
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
	// Detached: completion/cleanup must survive cancellation of the caller's
	// context (guaranteed removal).
	go e.complete(context.WithoutCancel(ctx), runID, h)
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

// complete is the terminalization goroutine: wait, decide, persist, then
// always cleanup (Stop→Remove with force on the detached context), release
// the semaphore and deregister the handle — including parse-failure paths,
// where the parse failure itself marks the run failed.
func (e *Engine) complete(ctx context.Context, runID string, h *handle) {
	containerID := h.container()
	defer e.deregister(runID)
	defer e.sem.Release()
	defer e.cleanup(ctx, containerID)

	exit, waitErr := e.rt.Wait(ctx, containerID)
	status, summary := e.decide(ctx, runID, containerID, exit, waitErr, h.stopRequested())
	if err := e.store.SetStatus(runID, status); err != nil {
		// Terminal immutability: if the run already reached a terminal state
		// (e.g. a stop landed first), the transition is rejected and no
		// summary is stored; the condition is logged, never retried.
		e.log.Error("run final status rejected", "runId", runID, "status", string(status), "error", err)
		return
	}
	if summary != nil {
		if err := e.store.SetSummary(runID, summary); err != nil {
			e.log.Error("run summary persist failed", "runId", runID, "error", err)
		}
	}
	if waitErr != nil {
		e.log.Info("run finalized", "runId", runID, "status", string(status), "wait_error", waitErr)
		return
	}
	e.log.Info("run finalized", "runId", runID, "status", string(status), "exit_code", exit)
}

// decide maps the wait result to the terminal status and its summary.
// Precedence: an explicit stop request wins over the exit-code mapping; a
// wait error or a mapped failure yields failed with no summary; a finished
// run parses its output, and a parse/output failure downgrades it to failed
// with no summary. Stopped runs tolerate parse failures (a killed container
// may truncate the stream) and fall back to an all-zero summary so the
// terminal-summary invariant holds for stopped runs.
func (e *Engine) decide(ctx context.Context, runID, containerID string, exit int, waitErr error, stopped bool) (runs.Status, *runs.Summary) {
	if stopped {
		summary, err := e.parse(ctx, containerID)
		if err != nil {
			e.log.Warn("output parse failed for stopped run; storing zero summary", "runId", runID, "error", err)
			return runs.StatusStopped, &runs.Summary{}
		}
		return runs.StatusStopped, summary
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
	summary, err := e.parse(ctx, containerID)
	if err != nil {
		e.log.Error("output parse failed; run marked failed", "runId", runID, "error", err)
		return runs.StatusFailed, nil
	}
	summary.ThresholdsPassed = passed
	return status, summary
}

// parse attaches the container output stream and aggregates it; the caller
// owns the returned summary pointer.
func (e *Engine) parse(ctx context.Context, containerID string) (*runs.Summary, error) {
	reader, err := e.rt.Output(ctx, containerID)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	summary, err := k6sum.Parse(reader)
	if err != nil {
		return nil, err
	}
	return &summary, nil
}

// spec builds the container spec from the stored run fields: the script via
// the reserved env key (stripped before container create by the runtime),
// `run --out json` with REST VUs/duration overriding script options, the
// run-id label and the contract limits. Spec contents are never logged.
func (e *Engine) spec(run runs.Run) runtime.Spec {
	return runtime.Spec{
		Image:   e.image,
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
// running promotion (no container is left running), frees the semaphore slot
// and drops the handle so the run can never be re-launched or leak a slot.
func (e *Engine) failLaunch(runID, stage string, err error) {
	e.log.Error("run launch failed", "runId", runID, "stage", stage, "error", err)
	if statusErr := e.store.SetStatus(runID, runs.StatusFailed); statusErr != nil {
		e.log.Error("launch failure transition failed", "runId", runID, "error", statusErr)
	}
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
