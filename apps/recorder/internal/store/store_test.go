package store

import (
	"testing"
)

func TestNew(t *testing.T) {
	s := New()
	if s == nil {
		t.Fatal("New() returned nil")
	}
}

func TestCreate(t *testing.T) {
	s := New()
	id := s.Create()

	if id == "" {
		t.Fatal("Create() returned empty ID")
	}

	rec := s.Get(id)
	if rec == nil {
		t.Fatal("Get() returned nil for created recording")
	}
	if rec.ID != id {
		t.Errorf("ID = %q, want %q", rec.ID, id)
	}
	if rec.Status != StatusPending {
		t.Errorf("Status = %q, want %q", rec.Status, StatusPending)
	}
	if len(rec.Captures) != 0 {
		t.Errorf("Captures = %d, want 0", len(rec.Captures))
	}
}

func TestGetNotFound(t *testing.T) {
	s := New()
	rec := s.Get("nonexistent")
	if rec != nil {
		t.Error("Get() should return nil for nonexistent ID")
	}
}

func TestSetStatus(t *testing.T) {
	s := New()
	id := s.Create()

	ok := s.SetStatus(id, StatusRecording)
	if !ok {
		t.Error("SetStatus() returned false for valid transition")
	}

	rec := s.Get(id)
	if rec.Status != StatusRecording {
		t.Errorf("Status = %q, want %q", rec.Status, StatusRecording)
	}
}

func TestSetStatusNotFound(t *testing.T) {
	s := New()
	ok := s.SetStatus("nonexistent", StatusRecording)
	if ok {
		t.Error("SetStatus() should return false for nonexistent ID")
	}
}

func TestSetStatusTerminal(t *testing.T) {
	s := New()
	id := s.Create()

	s.SetStatus(id, StatusCompleted)

	// Should not be able to change terminal status
	ok := s.SetStatus(id, StatusRecording)
	if ok {
		t.Error("SetStatus() should return false for terminal status")
	}

	rec := s.Get(id)
	if rec.Status != StatusCompleted {
		t.Errorf("Status = %q, want %q", rec.Status, StatusCompleted)
	}
}

func TestAddCapture(t *testing.T) {
	s := New()
	id := s.Create()
	s.SetStatus(id, StatusRecording)

	entry := CaptureEntry{
		Method:   "GET",
		URL:      "https://example.com/api",
		Status:   200,
		Headers:  []HeaderEntry{{Name: "Content-Type", Value: "application/json"}},
		Redacted: false,
	}

	ok := s.AddCapture(id, entry)
	if !ok {
		t.Error("AddCapture() returned false for recording status")
	}

	rec := s.Get(id)
	if len(rec.Captures) != 1 {
		t.Fatalf("Captures = %d, want 1", len(rec.Captures))
	}
	if rec.Captures[0].Method != "GET" {
		t.Errorf("Method = %q, want GET", rec.Captures[0].Method)
	}
}

func TestAddCaptureNotRecording(t *testing.T) {
	s := New()
	id := s.Create()

	entry := CaptureEntry{Method: "GET", URL: "https://example.com", Status: 200}

	// Status is pending, not recording
	ok := s.AddCapture(id, entry)
	if ok {
		t.Error("AddCapture() should return false when not recording")
	}
}

func TestAddCaptureNotFound(t *testing.T) {
	s := New()
	entry := CaptureEntry{Method: "GET", URL: "https://example.com", Status: 200}

	ok := s.AddCapture("nonexistent", entry)
	if ok {
		t.Error("AddCapture() should return false for nonexistent ID")
	}
}

func TestDelete(t *testing.T) {
	s := New()
	id := s.Create()

	s.Delete(id)

	rec := s.Get(id)
	if rec != nil {
		t.Error("Get() should return nil after Delete()")
	}
}

func TestList(t *testing.T) {
	s := New()
	id1 := s.Create()
	id2 := s.Create()

	ids := s.List()

	if len(ids) != 2 {
		t.Errorf("List() = %d items, want 2", len(ids))
	}

	found := make(map[string]bool)
	for _, id := range ids {
		found[id] = true
	}
	if !found[id1] || !found[id2] {
		t.Error("List() missing expected IDs")
	}
}

func TestStatusIsTerminal(t *testing.T) {
	tests := []struct {
		status   Status
		terminal bool
	}{
		{StatusPending, false},
		{StatusRecording, false},
		{StatusStopping, false},
		{StatusCompleted, true},
		{StatusFailed, true},
	}

	for _, tc := range tests {
		if got := tc.status.IsTerminal(); got != tc.terminal {
			t.Errorf("%q.IsTerminal() = %v, want %v", tc.status, got, tc.terminal)
		}
	}
}

func TestGetReturnsCopy(t *testing.T) {
	s := New()
	id := s.Create()
	s.SetStatus(id, StatusRecording)
	s.AddCapture(id, CaptureEntry{Method: "GET", URL: "https://a.com", Status: 200})

	rec1 := s.Get(id)
	rec2 := s.Get(id)

	// Modify the copy
	rec1.Captures = append(rec1.Captures, CaptureEntry{Method: "POST", URL: "https://b.com", Status: 201})

	// Original should be unchanged
	if len(rec2.Captures) != 1 {
		t.Error("Get() should return a copy, not a reference")
	}
}

func TestNewWithIDGenerator(t *testing.T) {
	calls := 0
	gen := func() string {
		calls++
		return "test-id"
	}

	s := NewWithIDGenerator(gen)
	id := s.Create()

	if id != "test-id" {
		t.Errorf("ID = %q, want test-id", id)
	}
	if calls != 1 {
		t.Errorf("generator called %d times, want 1", calls)
	}
}
