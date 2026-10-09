package runs

import (
	"sync"
	"testing"

	"k6flow/apps/orchestrator/internal/diagnostic"
)

func TestDiagnosticConcurrentSnapshotsAndFinish(t *testing.T) {
	store := NewStore()
	run, err := store.Create(Run{Mode: "diagnostic", Diagnostic: &diagnostic.Metadata{NodeIDs: []string{"a"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetStatus(run.ID, StatusRunning); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				got, _ := store.Get(run.ID)
				if got.Status.IsTerminal() && got.Trace.State == "running" {
					t.Error("inconsistent terminal snapshot")
				}
				got.Diagnostic.NodeIDs[0] = "mutated"
				got.Trace.State = "mutated"
			}
		}()
	}
	if err := store.SetStatus(run.ID, StatusStopped); err != nil {
		t.Fatal(err)
	}
	workers.Wait()
	got, _ := store.Get(run.ID)
	if got.Trace.State != "interrupted" || got.Diagnostic.NodeIDs[0] != "a" {
		t.Fatal("snapshot mutated")
	}
}

func TestDiagnosticCopiesAndTerminalBoundary(t *testing.T) {
	store := NewStore()
	metadata := &diagnostic.Metadata{NodeIDs: []string{"a"}}
	run, err := store.Create(Run{Mode: "diagnostic", Diagnostic: metadata})
	if err != nil {
		t.Fatal(err)
	}
	metadata.NodeIDs[0] = "mutated"
	run.Diagnostic.NodeIDs[0] = "mutated"
	run.Trace.State = "mutated"
	got, _ := store.Get(run.ID)
	if got.Diagnostic.NodeIDs[0] != "a" || got.Trace.State != "pending" {
		t.Fatalf("%+v", got)
	}
	if err := store.SetStatus(run.ID, StatusRunning); err != nil {
		t.Fatal(err)
	}
	store.DiagnosticLine(run.ID, []byte(`{"type":"Point","metric":"k6flow_diagnostic_event","data":{"value":0,"tags":{"seq":"1","nodeId":"a","event":"skipped","httpStatus":"0","outcome":"skipped","reason":"disabled"}}}`))
	store.DiagnosticLine(run.ID, []byte(`{"type":"Point","metric":"k6flow_diagnostic_event","data":{"value":0,"tags":{"seq":"2","nodeId":"","event":"complete","httpStatus":"0","outcome":"success","reason":"none"}}}`))
	got, _ = store.Get(run.ID)
	if got.Trace.State != "running" {
		t.Fatal("marker terminalized early")
	}
	got.Trace.Events[0].NodeID = "mutated"
	if err := store.SetStatus(run.ID, StatusFinished); err != nil {
		t.Fatal(err)
	}
	store.DiagnosticLine(run.ID, []byte(`{"metric":"k6flow_diagnostic_event"}`))
	got, _ = store.Get(run.ID)
	if got.Trace.State != "complete" || got.Trace.Events[0].NodeID != "a" {
		t.Fatalf("%+v", got.Trace)
	}
}
