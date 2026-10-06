package runs

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// allStatuses is the closed contract-04 status set, including legacy and new.
var allStatuses = []Status{StatusQueued, StatusPending, StatusStarting, StatusRunning, StatusStopping, StatusFinished, StatusFailed, StatusAborted, StatusErrored, StatusStopped}

// mustCreate stores run and fails the test on error.
func mustCreate(t *testing.T, store *Store, run Run) Run {
	t.Helper()
	created, err := store.Create(run)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return created
}

// mustStatus applies transition to and fails the test on error.
func mustStatus(t *testing.T, store *Store, id string, to Status) {
	t.Helper()
	if err := store.SetStatus(id, to); err != nil {
		t.Fatalf("SetStatus(%s): %v", to, err)
	}
}

// newStoreWithStatus returns a store whose single run already sits in status.
func newStoreWithStatus(t *testing.T, status Status) (*Store, string) {
	t.Helper()
	store := NewStore()
	run := mustCreate(t, store, Run{Script: "k6 run -", IdempotencyKey: "key", PayloadHash: "hash"})
	// Build path to desired status
	switch status {
	case StatusPending:
		// Already pending from Create
	case StatusRunning:
		mustStatus(t, store, run.ID, StatusRunning)
	case StatusQueued:
		// Manually set, not reachable from pending
		run, _ := store.Get(run.ID)
		run.Status = StatusQueued
		store.mu.Lock()
		store.runs[run.ID].Status = StatusQueued
		store.mu.Unlock()
	case StatusStarting:
		run, _ := store.Get(run.ID)
		store.mu.Lock()
		store.runs[run.ID].Status = StatusStarting
		store.mu.Unlock()
	case StatusStopping:
		mustStatus(t, store, run.ID, StatusRunning)
		mustStatus(t, store, run.ID, StatusStopping)
	default:
		// Terminal states via running
		if status != StatusPending {
			mustStatus(t, store, run.ID, StatusRunning)
		}
		if status != StatusPending && status != StatusRunning {
			mustStatus(t, store, run.ID, status)
		}
	}
	return store, run.ID
}

// TestStatusTransitionsLegalAndRejected walks every from -> to pair of the
// closed set against the legal-transition table, verifies rejected moves never
// mutate the stored status, and verifies started/finished timestamps.
func TestStatusTransitionsLegalAndRejected(t *testing.T) {
	legal := map[[2]Status]bool{
		// Legacy (pending-based flow)
		{StatusPending, StatusRunning}:  true,
		{StatusPending, StatusFailed}:   true,
		{StatusPending, StatusErrored}:  true,
		{StatusPending, StatusStopped}:  true,
		{StatusRunning, StatusFinished}: true,
		{StatusRunning, StatusFailed}:   true,
		{StatusRunning, StatusStopped}:  true,
		{StatusRunning, StatusAborted}:  true,
		{StatusRunning, StatusErrored}:  true,
		{StatusRunning, StatusStopping}: true,
		// New flow (queued -> starting -> running)
		{StatusQueued, StatusStarting}:  true,
		{StatusQueued, StatusAborted}:   true,
		{StatusQueued, StatusStopped}:   true,
		{StatusStarting, StatusRunning}: true,
		{StatusStarting, StatusErrored}: true,
		{StatusStarting, StatusAborted}: true,
		{StatusStarting, StatusStopped}: true,
		// Stopping state
		{StatusStopping, StatusAborted}:  true,
		{StatusStopping, StatusStopped}:  true,
		{StatusStopping, StatusFinished}: true,
		{StatusStopping, StatusFailed}:   true,
		{StatusStopping, StatusErrored}:  true,
	}
	for _, from := range allStatuses {
		for _, to := range allStatuses {
			t.Run(string(from)+">"+string(to), func(t *testing.T) {
				store, id := newStoreWithStatus(t, from)
				err := store.SetStatus(id, to)
				want := from
				if legal[[2]Status{from, to}] {
					want = to
				}
				if legal[[2]Status{from, to}] != (err == nil) {
					t.Fatalf("SetStatus(%s->%s) err = %v, want legal = %v", from, to, err, legal[[2]Status{from, to}])
				}
				run, ok := store.Get(id)
				if !ok || run.Status != want {
					t.Fatalf("status after SetStatus = %q, want %q", run.Status, want)
				}
				if err == nil && to == StatusRunning && run.StartedAt == nil {
					t.Error("accepted ->running did not stamp StartedAt")
				}
				if err == nil && to.IsTerminal() && run.FinishedAt == nil {
					t.Error("accepted terminal move did not stamp FinishedAt")
				}
			})
		}
	}
}

// TestStatusValidation covers the closed set, rejects foreign values and
// checks nullable timestamps stay nil while pending.
func TestStatusValidation(t *testing.T) {
	for _, status := range allStatuses {
		if !status.Valid() {
			t.Errorf("Valid(%q) = false, want true", status)
		}
	}
	for _, status := range []Status{"", "Pending", "done", "canceled"} {
		if status.Valid() {
			t.Errorf("Valid(%q) = true, want false", status)
		}
	}
	store, id := newStoreWithStatus(t, StatusPending)
	if err := store.SetStatus(id, "bogus"); err == nil {
		t.Error("SetStatus accepted a value outside the closed set")
	}
	if run, _ := store.Get(id); run.StartedAt != nil || run.FinishedAt != nil {
		t.Errorf("pending run already stamped: %+v", run)
	}
}

// TestCreateAndGetListDedupe covers id generation, forced pending status,
// lookup, reconciliation listing and the idempotency index including negatives.
func TestCreateAndGetListDedupe(t *testing.T) {
	store := NewStore()
	now := time.Now()
	first := mustCreate(t, store, Run{Status: StatusFinished, Script: "s", Summary: &Summary{}, CreatedAt: now, StartedAt: &now, IdempotencyKey: "dedupe", PayloadHash: "hash-a"})
	second := mustCreate(t, store, Run{Script: "s", IdempotencyKey: "other", PayloadHash: "hash-a"})
	if !strings.HasPrefix(first.ID, "run-") || first.ID == second.ID {
		t.Errorf("ids = %q / %q, want distinct run- prefix", first.ID, second.ID)
	}
	if first.Status != StatusPending || first.Summary != nil || first.StartedAt != nil || first.CreatedAt.IsZero() {
		t.Errorf("Create kept stale fields or missed CreatedAt: %+v", first)
	}
	if id, ok := store.FindByDedupe("dedupe", "hash-a"); !ok || id != first.ID {
		t.Errorf("FindByDedupe hit = %q, %v, want %q", id, ok, first.ID)
	}
	if _, ok := store.FindByDedupe("dedupe", "hash-b"); ok {
		t.Error("wrong payload hash matched")
	}
	if _, ok := store.FindByDedupe("", "hash-a"); ok {
		t.Error("absent key matched")
	}
	if run, ok := store.Get("run-missing"); ok {
		t.Errorf("Get found %q", run.ID)
	}
	if got := len(store.List()); got != 2 {
		t.Errorf("List len = %d, want 2", got)
	}
}

// TestSetSummaryRequiresTerminalStatus covers the 409-precursor rule and the
// opaque terminal payload storage.
func TestSetSummaryRequiresTerminalStatus(t *testing.T) {
	for _, status := range []Status{StatusPending, StatusRunning} {
		store, id := newStoreWithStatus(t, status)
		if err := store.SetSummary(id, &Summary{ThresholdsPassed: true}); err == nil {
			t.Errorf("SetSummary accepted non-terminal %s", status)
		}
	}
	store, id := newStoreWithStatus(t, StatusFinished)
	want := &Summary{Totals: Totals{Requests: 3, Errors: 1}, LatencyMs: LatencyMs{Avg: 12.5, P99: 90}, ThresholdsPassed: true}
	if err := store.SetSummary(id, want); err != nil {
		t.Fatalf("SetSummary: %v", err)
	}
	if run, _ := store.Get(id); run.Summary == nil || *run.Summary != *want {
		t.Errorf("stored Summary = %+v, want %+v", run.Summary, want)
	}
}

// TestStoreConcurrentCreateGetList exercises the mutex paths under -race.
func TestStoreConcurrentCreateGetList(t *testing.T) {
	store := NewStore()
	const workers, perWorker = 8, 25
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				key := fmt.Sprintf("k-%d-%d", w, i)
				created, err := store.Create(Run{IdempotencyKey: key})
				if err != nil {
					t.Errorf("Create: %v", err)
					return
				}
				if _, ok := store.Get(created.ID); !ok {
					t.Errorf("Get(%s) missed", created.ID)
					return
				}
				if id, ok := store.FindByDedupe(key, ""); !ok || id != created.ID {
					t.Errorf("FindByDedupe miss for %q", key)
					return
				}
				_ = store.List()
			}
		}(w)
	}
	wg.Wait()
	if got := len(store.List()); got != workers*perWorker {
		t.Errorf("List len = %d, want %d", got, workers*perWorker)
	}
}
