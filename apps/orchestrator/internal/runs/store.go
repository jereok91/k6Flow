// Package runs provides the in-memory run store for orchestrator runs.
package runs

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"k6flow/apps/orchestrator/internal/diagnostic"
)

// Status is the lifecycle state of a run.
type Status string

// The closed set of run statuses.
const (
	StatusQueued   Status = "queued"   // waiting for capacity
	StatusPending  Status = "pending"  // legacy: use Starting
	StatusStarting Status = "starting" // container being created
	StatusRunning  Status = "running"  // k6 executing
	StatusStopping Status = "stopping" // graceful shutdown requested
	StatusFinished Status = "finished" // completed, thresholds passed
	StatusFailed   Status = "failed"   // thresholds failed or script error
	StatusAborted  Status = "aborted"  // stopped by user
	StatusErrored  Status = "errored"  // infrastructure error
	StatusStopped  Status = "stopped"  // legacy: maps to Aborted
)

// Valid reports whether the status belongs to the closed set.
func (s Status) Valid() bool {
	switch s {
	case StatusQueued, StatusPending, StatusStarting, StatusRunning, StatusStopping,
		StatusFinished, StatusFailed, StatusAborted, StatusErrored, StatusStopped:
		return true
	default:
		return false
	}
}

// IsTerminal reports whether the status is a terminal state.
func (s Status) IsTerminal() bool {
	switch s {
	case StatusFinished, StatusFailed, StatusAborted, StatusErrored, StatusStopped:
		return true
	default:
		return false
	}
}

// legalMoves is the legal transition table.
// Note: stopped is legacy; prefer aborted for user-initiated stops.
var legalMoves = map[Status][]Status{
	StatusQueued:   {StatusStarting, StatusAborted, StatusStopped},    // can cancel from queue
	StatusPending:  {StatusRunning, StatusFailed, StatusErrored, StatusStopped}, // legacy
	StatusStarting: {StatusRunning, StatusErrored, StatusAborted, StatusStopped}, // container start
	StatusRunning:  {StatusStopping, StatusFinished, StatusFailed, StatusErrored, StatusStopped, StatusAborted},
	StatusStopping: {StatusAborted, StatusFinished, StatusFailed, StatusErrored, StatusStopped},
}

// canMove reports whether the from -> to transition is legal.
func canMove(from, to Status) bool {
	for _, next := range legalMoves[from] {
		if next == to {
			return true
		}
	}
	return false
}

// Totals are the cumulative end-of-run counters of the summary contract.
type Totals struct {
	Requests     int64
	Errors       int64
	FailedChecks int64
	Iterations   int64
}

// LatencyMs are the cumulative latency quantiles in milliseconds.
type LatencyMs struct {
	Avg, P90, P95, P99 float64
}

// Summary is the opaque terminal payload stored when a run reaches a terminal
// status; K6F2-04 fills it from the k6 JSON output.
type Summary struct {
	Totals           Totals
	LatencyMs        LatencyMs
	ThresholdsPassed bool
	DataReceived     int64 // bytes received
	DataSent         int64 // bytes sent
}

// RunEvent records a state transition for auditing.
type RunEvent struct {
	ID        string
	RunID     string
	At        time.Time
	FromState Status
	ToState   Status
	Actor     string // "system", "user", "orchestrator"
	Cause     string // reason for transition
}

// Result is the outcome of a completed run.
type Result string

const (
	ResultPassed          Result = "passed"           // all thresholds OK
	ResultThresholdFailed Result = "thresholds_failed" // some threshold breached
	ResultAborted         Result = "aborted"          // user stopped
	ResultErrored         Result = "errored"          // infrastructure error
)

// Run is one stored run. CreatedAt is always set; StartedAt and FinishedAt
// stay nil until SetStatus stamps them.
type Run struct {
	Mode           string
	Diagnostic     *diagnostic.Metadata
	Trace          *diagnostic.Snapshot
	ID             string
	Status         Status
	Result         Result  // set when terminal
	Script         string
	ScenarioID     string  // reference to scenario
	ScenarioName   string
	VUs            int
	DurationMs     int
	CPUMillis      int
	MemoryMiB      int
	Attachments    []string
	IdempotencyKey string
	PayloadHash    string
	ContainerID    string   // Docker container ID
	ExitCode       int      // k6 exit code
	AbortReason    string   // if aborted, why
	Summary        *Summary
	Events         []RunEvent
	CreatedAt      time.Time
	QueuedAt       *time.Time
	StartedAt      *time.Time
	FinishedAt     *time.Time
}

// EndpointsData is an interface for per-run endpoint metrics.
type EndpointsData interface {
	GetEndpointsJSON() ([]byte, error)
	GetFailuresJSON() ([]byte, error)
}

// Store is a mutex-protected in-memory run registry safe for concurrent use.
type Store struct {
	mu        sync.RWMutex
	runs      map[string]*Run
	dedupe    map[string]string
	endpoints map[string]EndpointsData // per-run endpoint trackers
}

// NewStore returns an empty run store.
func NewStore() *Store {
	return &Store{
		runs:      map[string]*Run{},
		dedupe:    map[string]string{},
		endpoints: map[string]EndpointsData{},
	}
}

// Create assigns a fresh unique "run-<hex>" id, forces Status pending, stamps
// CreatedAt, clears stale terminal fields, and indexes a non-empty idempotency
// key with its payload hash for FindByDedupe. It returns a detached copy.
func (s *Store) Create(run Run) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var id string
	for {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return Run{}, fmt.Errorf("runs: generate id: %w", err)
		}
		id = "run-" + hex.EncodeToString(random[:])
		if _, taken := s.runs[id]; !taken {
			break
		}
	}
	if run.Mode == "" {
		run.Mode = "load"
	}
	if run.Mode != "load" && run.Mode != "diagnostic" {
		return Run{}, fmt.Errorf("runs: invalid mode")
	}
	if run.Mode == "diagnostic" {
		if run.Diagnostic == nil || run.Diagnostic.Validate() != nil {
			return Run{}, fmt.Errorf("runs: invalid diagnostic metadata")
		}
		metadata := *run.Diagnostic
		metadata.NodeIDs = append([]string(nil), metadata.NodeIDs...)
		run.Diagnostic = &metadata
		trace := diagnostic.New()
		run.Trace = &trace
	} else {
		if run.Diagnostic != nil {
			return Run{}, fmt.Errorf("runs: load forbids diagnostic metadata")
		}
		run.Trace = nil
	}
	run.ID = id
	run.Status = StatusPending
	run.Summary = nil
	run.StartedAt = nil
	run.FinishedAt = nil
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now()
	}
	run.Attachments = append([]string(nil), run.Attachments...)
	s.runs[id] = &run
	if run.IdempotencyKey != "" {
		s.dedupe[run.IdempotencyKey+"\x00"+run.PayloadHash] = id
	}
	return copyRun(run), nil
}

// Get returns a detached copy of the stored run and whether the id exists.
func (s *Store) Get(id string) (Run, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, ok := s.runs[id]
	if !ok {
		return Run{}, false
	}
	return copyRun(*run), true
}

// SetStatus applies a legal transition, stamps the started and finished
// timestamps, and rejects unknown ids, values outside the closed set, illegal
// moves, and any change from an immutable terminal state.
func (s *Store) SetStatus(id string, to Status) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[id]
	if !ok {
		return fmt.Errorf("runs: unknown run %q", id)
	}
	if !to.Valid() {
		return fmt.Errorf("runs: invalid status %q", to)
	}
	if !canMove(run.Status, to) {
		return fmt.Errorf("runs: illegal transition %s -> %s for run %s", run.Status, to, id)
	}
	from := run.Status
	run.Status = to
	now := time.Now()
	if to == StatusRunning {
		run.StartedAt = &now
	}
	if to.IsTerminal() {
		run.FinishedAt = &now
	}
	updateTraceStatus(run, to)
	// Record event
	event := RunEvent{
		ID:        generateEventID(),
		RunID:     id,
		At:        now,
		FromState: from,
		ToState:   to,
		Actor:     "system",
	}
	run.Events = append(run.Events, event)
	return nil
}

// SetStatusWithCause applies a legal transition and records the cause.
func (s *Store) SetStatusWithCause(id string, to Status, actor, cause string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[id]
	if !ok {
		return fmt.Errorf("runs: unknown run %q", id)
	}
	if !to.Valid() {
		return fmt.Errorf("runs: invalid status %q", to)
	}
	if !canMove(run.Status, to) {
		return fmt.Errorf("runs: illegal transition %s -> %s for run %s", run.Status, to, id)
	}
	from := run.Status
	run.Status = to
	now := time.Now()
	if to == StatusRunning {
		run.StartedAt = &now
	}
	if to.IsTerminal() {
		run.FinishedAt = &now
	}
	updateTraceStatus(run, to)
	event := RunEvent{
		ID:        generateEventID(),
		RunID:     id,
		At:        now,
		FromState: from,
		ToState:   to,
		Actor:     actor,
		Cause:     cause,
	}
	run.Events = append(run.Events, event)
	return nil
}

func generateEventID() string {
	var random [8]byte
	rand.Read(random[:])
	return "evt-" + hex.EncodeToString(random[:])
}

// SetSummary stores a detached copy of the terminal payload; the run must
// have reached a terminal status first (the summary endpoint's 409 rule).
func (s *Store) SetSummary(id string, summary *Summary) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[id]
	if !ok {
		return fmt.Errorf("runs: unknown run %q", id)
	}
	if len(legalMoves[run.Status]) > 0 {
		return fmt.Errorf("runs: summary before terminal status for run %s", id)
	}
	if summary != nil {
		detached := *summary
		run.Summary = &detached
	} else {
		run.Summary = nil
	}
	return nil
}

// FindByDedupe returns the runId recorded for an idempotency key and payload
// hash; an absent (empty) key never matches.
func (s *Store) FindByDedupe(key, payloadHash string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if key == "" {
		return "", false
	}
	id, ok := s.dedupe[key+"\x00"+payloadHash]
	return id, ok
}

// List returns detached copies of every stored run, for reconciliation.
func (s *Store) List() []Run {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runs := make([]Run, 0, len(s.runs))
	for _, run := range s.runs {
		runs = append(runs, copyRun(*run))
	}
	return runs
}

// copyRun detaches slices and summaries so callers cannot mutate stored state.
func copyRun(run Run) Run {
	if run.Diagnostic != nil {
		metadata := *run.Diagnostic
		metadata.NodeIDs = append([]string(nil), metadata.NodeIDs...)
		run.Diagnostic = &metadata
	}
	if run.Trace != nil {
		trace := diagnostic.Copy(*run.Trace)
		run.Trace = &trace
	}
	run.Events = append([]RunEvent(nil), run.Events...)
	run.Attachments = append([]string(nil), run.Attachments...)
	if run.Summary != nil {
		summary := *run.Summary
		run.Summary = &summary
	}
	return run
}

// DiagnosticLine consumes custom output under the transition lock. Terminal
// snapshots reject late writes, including malformed points.
func (s *Store) DiagnosticLine(id string, line []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[id]
	if !ok || run.Trace == nil {
		return false
	}
	return diagnostic.Consume(run.Trace, *run.Diagnostic, line)
}

func (s *Store) InvalidateDiagnostic(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run, ok := s.runs[id]; ok && run.Trace != nil {
		diagnostic.Invalidate(run.Trace)
	}
}

func updateTraceStatus(run *Run, to Status) {
	if run.Trace == nil {
		return
	}
	if to == StatusRunning {
		run.Trace.State = "running"
	}
	if to.IsTerminal() {
		diagnostic.Finish(run.Trace, string(to))
	}
}

// SetEndpoints stores the per-run endpoints tracker.
func (s *Store) SetEndpoints(id string, data EndpointsData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.endpoints[id] = data
}

// GetEndpoints returns the per-run endpoints tracker.
func (s *Store) GetEndpoints(id string) (EndpointsData, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, ok := s.endpoints[id]
	return data, ok
}
