package runtime

import (
	"context"
	"errors"
	"io"
	"slices"
	"sync"
	"testing"
	"time"
)

func TestFakeDiagnosticSpecCopies(t *testing.T) {
	fake := NewFakeRuntime()
	spec := Spec{DiagnosticEntry:[]byte("entry"), Env:map[string]string{ScriptEnvKey:"source"}, Args:[]string{"arg"}}
	if _, err := fake.Create(context.Background(), spec); err != nil { t.Fatal(err) }
	spec.DiagnosticEntry[0] = 'X'; spec.Env[ScriptEnvKey] = "mutated"; spec.Args[0] = "mutated"
	first := fake.Specs()[0]
	first.DiagnosticEntry[0] = 'Y'; first.Env[ScriptEnvKey] = "mutated"
	got := fake.Specs()[0]
	if string(got.DiagnosticEntry) != "entry" || got.Env[ScriptEnvKey] != "source" || got.Args[0] != "arg" { t.Fatal("spec aliasing") }
}

// must fails the test when a fake call reports an error.
func must(t *testing.T, op string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
}

// TestFakeRuntimeRecordsCallsAndScriptedBehavior covers call recording,
// scripted exit code/output, ListLabeled scripting and spec capture.
func TestFakeRuntimeRecordsCallsAndScriptedBehavior(t *testing.T) {
	ctx := context.Background()
	fake := NewFakeRuntime()
	id, err := fake.Create(ctx, Spec{Image: "grafana/k6", CPUMillis: 500, MemoryMiB: 256, Labels: map[string]string{"k6flow.managed": "true"}, Network: "k6flow"})
	must(t, "Create", err)
	fake.SetExitCode(id, 3)
	fake.SetOutput(id, `{"type":"summary"}`)
	must(t, "Start", fake.Start(ctx, id))
	if code, err := fake.Wait(ctx, id); err != nil || code != 3 {
		t.Fatalf("Wait = %d, %v", code, err)
	}
	must(t, "Stop", fake.Stop(ctx, id, 5*time.Second))
	must(t, "Remove", fake.Remove(ctx, id, true))
	reader, err := fake.Output(ctx, id)
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	output, err := io.ReadAll(reader)
	if err != nil || string(output) != `{"type":"summary"}` {
		t.Fatalf("Output = %q, %v", output, err)
	}
	fake.SetContainers([]string{"orphan-1"})
	ids, err := fake.ListLabeled(ctx)
	if err != nil || !slices.Equal(ids, []string{"orphan-1"}) {
		t.Fatalf("ListLabeled = %v, %v", ids, err)
	}
	want := []string{"Create:" + id, "Start:" + id, "Wait:" + id, "Stop:" + id, "Remove:" + id, "Output:" + id, "ListLabeled"}
	if !slices.Equal(fake.Calls(), want) {
		t.Errorf("Calls = %v, want %v", fake.Calls(), want)
	}
	specs := fake.Specs()
	if len(specs) != 1 || specs[0].Image != "grafana/k6" || specs[0].MemoryMiB != 256 {
		t.Errorf("Specs = %+v", specs)
	}
}

// TestFakeRuntimeErrorInjectionKeepsStopBeforeRemoveOrdering proves per-call
// and per-op error injection while Stop-then-Remove ordering stays assertable
// on failure paths (guaranteed removal is K6F2-03 logic built on this fake).
func TestFakeRuntimeErrorInjectionKeepsStopBeforeRemoveOrdering(t *testing.T) {
	ctx := context.Background()
	fake := NewFakeRuntime()
	id, err := fake.Create(ctx, Spec{Image: "grafana/k6"})
	must(t, "Create", err)
	fake.SetError("Wait:"+id, errors.New("engine broke"))
	if _, err := fake.Wait(ctx, id); err == nil {
		t.Fatal("Wait ignored injected per-call error")
	}
	must(t, "Stop", fake.Stop(ctx, id, time.Second))
	must(t, "Remove", fake.Remove(ctx, id, true))
	want := []string{"Create:" + id, "Wait:" + id, "Stop:" + id, "Remove:" + id}
	if !slices.Equal(fake.Calls(), want) {
		t.Errorf("Calls = %v, want %v", fake.Calls(), want)
	}
	fake.SetError("Create", errors.New("no capacity"))
	if _, err := fake.Create(ctx, Spec{}); err == nil {
		t.Fatal("Create ignored injected op-level error")
	}
}

// TestFakeRuntimeConcurrentUse hammers the fake from goroutines for -race.
func TestFakeRuntimeConcurrentUse(t *testing.T) {
	ctx := context.Background()
	fake := NewFakeRuntime()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := fake.Create(ctx, Spec{Image: "grafana/k6"})
			if err != nil {
				t.Errorf("Create: %v", err)
				return
			}
			_ = fake.Start(ctx, id)
			_, _ = fake.Wait(ctx, id)
			_ = fake.Stop(ctx, id, time.Second)
			_ = fake.Remove(ctx, id, true)
			_ = fake.Calls()
		}()
	}
	wg.Wait()
	if got := len(fake.Calls()); got != 40 {
		t.Errorf("Calls = %d, want 40", got)
	}
}
