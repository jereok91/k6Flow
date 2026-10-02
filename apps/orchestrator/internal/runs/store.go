// Package runs provides the in-memory run store for orchestrator runs.
package runs

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Status is the lifecycle state of a run; the value set is the closed
// contract-04 set pending|running|finished|failed|stopped.
type Status string

// The closed set of run statuses (REST contract 04).
const (
	StatusPending  Status = "pending"
	StatusRunning  Status = "running"
	StatusFinished Status = "finished"
	StatusFailed   Status = "failed"
	StatusStopped  Status = "stopped"
)

// Valid reports whether the status belongs to the closed set.
func (s Status) Valid() bool {
	switch s {
	case StatusPending, StatusRunning, StatusFinished, StatusFailed, StatusStopped:
		return true
	default:
		return false
	}
}

// legalMoves is the legal transition table: pending -> running; running ->
// finished|failed|stopped. Terminal states have no outgoing moves, so they
// are immutable.
var legalMoves = map[Status][]Status{
	StatusPending: {StatusRunning},
	StatusRunning: {StatusFinished, StatusFailed, StatusStopped},
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
}

// Run is one stored run. CreatedAt is always set; StartedAt and FinishedAt
// stay nil until SetStatus stamps them.
type Run struct {
	ID             string
	Status         Status
	Script         string
	VUs            int
	DurationMs     int
	CPUMillis      int
	MemoryMiB      int
	Attachments    []string
	IdempotencyKey string
	PayloadHash    string
	Summary        *Summary
	CreatedAt      time.Time
	StartedAt      *time.Time
	FinishedAt     *time.Time
}

// Store is a mutex-protected in-memory run registry safe for concurrent use.
type Store struct {
	mu     sync.RWMutex
	runs   map[string]*Run
	dedupe map[string]string
}

// NewStore returns an empty run store.
func NewStore() *Store {
	return &Store{
		runs:   map[string]*Run{},
		dedupe: map[string]string{},
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
	run.Status = to
	now := time.Now()
	if to == StatusRunning {
		run.StartedAt = &now
	}
	if to == StatusFinished || to == StatusFailed || to == StatusStopped {
		run.FinishedAt = &now
	}
	return nil
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
	run.Attachments = append([]string(nil), run.Attachments...)
	if run.Summary != nil {
		summary := *run.Summary
		run.Summary = &summary
	}
	return run
}
