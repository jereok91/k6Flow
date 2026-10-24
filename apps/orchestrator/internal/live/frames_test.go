package live

import (
	"fmt"
	"sync"
	"testing"
)

// The retained frame is what the polling fallback serves, so it must be the
// newest window of each run, keyed per run, and gone once the run ends.

func TestLastFrameRetainsLatestPerRun(t *testing.T) {
	env := newTestEnv(t)

	if _, ok := env.srv.LastFrame("run-1"); ok {
		t.Fatal("LastFrame reported a snapshot for a run without frames")
	}

	env.srv.OnFrame(mkFrame("run-1", 0))
	env.srv.OnFrame(mkFrame("run-2", 5))
	env.srv.OnFrame(mkFrame("run-1", 3))

	got, ok := env.srv.LastFrame("run-1")
	if !ok || got.Seq != 3 {
		t.Fatalf("run-1 snapshot = (%d, %v), want seq 3", got.Seq, ok)
	}
	if other, ok := env.srv.LastFrame("run-2"); !ok || other.Seq != 5 {
		t.Fatalf("run-2 snapshot = (%d, %v), want seq 5 (runs stay independent)", other.Seq, ok)
	}
	if unknown, ok := env.srv.LastFrame("run-3"); ok {
		t.Fatalf("LastFrame returned %+v for an unknown run", unknown)
	}
}

func TestLastFrameEvictsOldestInsertionWhenFull(t *testing.T) {
	env := newTestEnv(t)
	cache := env.srv.frames
	for i := 0; i < cache.max; i++ {
		env.srv.OnFrame(mkFrame(runIDFor(i), 0))
	}
	// Refreshing a retained run must not evict a peer.
	env.srv.OnFrame(mkFrame(runIDFor(0), 9))
	if _, ok := env.srv.LastFrame(runIDFor(cache.max - 1)); !ok {
		t.Fatal("refreshing a retained run evicted another run")
	}

	// A new run evicts exactly the oldest insertion.
	env.srv.OnFrame(mkFrame("overflow-run", 0))
	if _, ok := env.srv.LastFrame(runIDFor(0)); ok {
		t.Fatal("oldest insertion survived after the cache filled up")
	}
	if frame, ok := env.srv.LastFrame("overflow-run"); !ok || frame.Seq != 0 {
		t.Fatalf("newest run snapshot = (%d, %v), want seq 0", frame.Seq, ok)
	}
	if frame, ok := env.srv.LastFrame(runIDFor(1)); !ok || frame.Seq != 0 {
		t.Fatalf("second-oldest run snapshot = (%d, %v), want it retained", frame.Seq, ok)
	}
	cache.mu.Lock()
	retained := len(cache.frames)
	ordered := len(cache.order)
	cache.mu.Unlock()
	if retained != cache.max || ordered != cache.max {
		t.Fatalf("cache holds %d frames / %d order entries, want %d (bounded)", retained, ordered, cache.max)
	}
}

func TestCloseRunDropsRetainedFrame(t *testing.T) {
	env := newTestEnv(t)
	env.srv.OnFrame(mkFrame("run-1", 0))
	env.srv.OnFrame(mkFrame("run-2", 0))

	env.srv.CloseRun("run-1", closeNormal)

	if _, ok := env.srv.LastFrame("run-1"); ok {
		t.Fatal("terminal run still serves a metrics snapshot")
	}
	if _, ok := env.srv.LastFrame("run-2"); !ok {
		t.Fatal("closing run-1 dropped run-2's snapshot")
	}

	// Dropping an unknown run is a no-op, not a panic.
	env.srv.CloseRun("never-seen", closeNormal)
}

func TestLastFrameSafeForConcurrentUse(t *testing.T) {
	env := newTestEnv(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			for seq := int64(0); seq < 50; seq++ {
				env.srv.OnFrame(mkFrame("run-1", seq))
				env.srv.OnFrame(mkFrame(runIDFor(i), seq))
			}
		}(i)
		go func() {
			defer wg.Done()
			for n := 0; n < 50; n++ {
				_, _ = env.srv.LastFrame("run-1")
				env.srv.CloseRun(runIDFor(100), closeNormal)
			}
		}()
	}
	wg.Wait()
	if _, ok := env.srv.LastFrame("run-1"); !ok {
		t.Fatal("concurrent readers lost the retained snapshot")
	}
}

func runIDFor(i int) string {
	return fmt.Sprintf("run-%d", i)
}
