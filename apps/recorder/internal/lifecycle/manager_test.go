package lifecycle

import (
	"sync"
	"testing"
	"time"

	"k6flow/apps/recorder/internal/store"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.MaxDuration != time.Hour {
		t.Errorf("MaxDuration = %v, want 1h", cfg.MaxDuration)
	}
	if cfg.Inactivity != 5*time.Minute {
		t.Errorf("Inactivity = %v, want 5m", cfg.Inactivity)
	}
	if cfg.CheckPeriod != 30*time.Second {
		t.Errorf("CheckPeriod = %v, want 30s", cfg.CheckPeriod)
	}
}

func TestStartStop(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: time.Hour,
		Inactivity:  time.Minute,
		CheckPeriod: 10 * time.Millisecond,
	}
	m := New(st, cfg)

	m.Start()
	m.Start() // Double start should be safe

	time.Sleep(20 * time.Millisecond)

	m.Stop()
	m.Stop() // Double stop should be safe
}

func TestInactivityExpiration(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: time.Hour,
		Inactivity:  10 * time.Millisecond,
		CheckPeriod: 5 * time.Millisecond,
	}
	m := New(st, cfg)

	var mu sync.Mutex
	var expired []string
	m.OnExpire(func(id string, trigger string) {
		mu.Lock()
		expired = append(expired, id)
		if trigger != "inactivity" {
			t.Errorf("trigger = %q, want inactivity", trigger)
		}
		mu.Unlock()
	})

	// Create a recording
	id := st.Create()
	st.SetStatus(id, store.StatusRecording)

	m.Start()
	defer m.Stop()

	// Wait for expiration
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(expired) == 0 {
		t.Error("recording should have expired")
	}

	rec := st.Get(id)
	if rec.Status != store.StatusFailed {
		t.Errorf("status = %q, want failed", rec.Status)
	}
}

func TestMaxDurationExpiration(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: 10 * time.Millisecond,
		Inactivity:  time.Hour, // Don't trigger inactivity
		CheckPeriod: 5 * time.Millisecond,
	}
	m := New(st, cfg)

	var triggered bool
	m.OnExpire(func(id string, trigger string) {
		if trigger == "max-duration" {
			triggered = true
		}
	})

	id := st.Create()
	st.SetStatus(id, store.StatusRecording)

	m.Start()
	defer m.Stop()

	time.Sleep(50 * time.Millisecond)

	if !triggered {
		t.Error("max-duration should have triggered")
	}
}

func TestTerminalNotExpired(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: 10 * time.Millisecond,
		Inactivity:  10 * time.Millisecond,
		CheckPeriod: 5 * time.Millisecond,
	}
	m := New(st, cfg)

	var expired bool
	m.OnExpire(func(id string, trigger string) {
		expired = true
	})

	// Create a completed recording
	id := st.Create()
	st.SetStatus(id, store.StatusCompleted)

	m.Start()
	time.Sleep(30 * time.Millisecond)
	m.Stop()

	if expired {
		t.Error("terminal recording should not expire")
	}

	rec := st.Get(id)
	if rec.Status != store.StatusCompleted {
		t.Errorf("status = %q, want completed", rec.Status)
	}
}

func TestCleanupAllOnStop(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: time.Hour,
		Inactivity:  time.Hour,
		CheckPeriod: time.Hour, // Won't trigger during test
	}
	m := New(st, cfg)

	var triggers []string
	m.OnExpire(func(id string, trigger string) {
		triggers = append(triggers, trigger)
	})

	// Create some recordings
	id1 := st.Create()
	st.SetStatus(id1, store.StatusRecording)
	id2 := st.Create()
	st.SetStatus(id2, store.StatusPending)
	id3 := st.Create()
	st.SetStatus(id3, store.StatusCompleted) // Terminal, should not be cleaned

	m.Start()
	m.Stop()

	// Should have cleaned up 2 non-terminal recordings
	if len(triggers) != 2 {
		t.Errorf("triggers = %d, want 2", len(triggers))
	}

	for _, trigger := range triggers {
		if trigger != "closed" {
			t.Errorf("trigger = %q, want closed", trigger)
		}
	}

	// id3 should still be completed
	rec := st.Get(id3)
	if rec.Status != store.StatusCompleted {
		t.Errorf("id3 status = %q, want completed", rec.Status)
	}
}

func TestMarkActive(t *testing.T) {
	st := store.New()
	cfg := Config{
		MaxDuration: time.Hour,
		Inactivity:  20 * time.Millisecond,
		CheckPeriod: 10 * time.Millisecond,
	}
	m := New(st, cfg)

	var expired bool
	m.OnExpire(func(id string, trigger string) {
		expired = true
	})

	id := st.Create()
	st.SetStatus(id, store.StatusRecording)

	m.Start()
	defer m.Stop()

	// Keep marking active
	for i := 0; i < 5; i++ {
		time.Sleep(10 * time.Millisecond)
		m.MarkActive(id)
	}

	if expired {
		t.Error("active recording should not expire")
	}
}
