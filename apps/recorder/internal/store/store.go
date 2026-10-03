// Package store provides in-memory storage for recording sessions.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Status represents the recording lifecycle state.
type Status string

const (
	StatusPending   Status = "pending"
	StatusRecording Status = "recording"
	StatusStopping  Status = "stopping"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

// IsTerminal returns true if the status is a terminal state.
func (s Status) IsTerminal() bool {
	return s == StatusCompleted || s == StatusFailed
}

// HeaderEntry is a captured HTTP header.
type HeaderEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// CaptureEntry is a captured HTTP request/response pair.
type CaptureEntry struct {
	Method      string        `json:"method"`
	URL         string        `json:"url"`
	Status      int           `json:"status"`
	Headers     []HeaderEntry `json:"headers"`
	BodyExcerpt string        `json:"bodyExcerpt,omitempty"`
	Redacted    bool          `json:"redacted"`
}

// Recording represents a recording session.
type Recording struct {
	ID         string
	Status     Status
	Captures   []CaptureEntry
	CreatedAt  time.Time
	LastActive time.Time
}

// Store manages recording sessions in memory.
type Store struct {
	mu         sync.RWMutex
	recordings map[string]*Recording
	genID      func() string
}

// New creates a new recording store.
func New() *Store {
	return &Store{
		recordings: make(map[string]*Recording),
		genID:      generateID,
	}
}

// NewWithIDGenerator creates a store with a custom ID generator (for testing).
func NewWithIDGenerator(genID func() string) *Store {
	return &Store{
		recordings: make(map[string]*Recording),
		genID:      genID,
	}
}

// Create creates a new recording session and returns its ID.
func (s *Store) Create() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.genID()
	now := time.Now()
	s.recordings[id] = &Recording{
		ID:         id,
		Status:     StatusPending,
		Captures:   []CaptureEntry{},
		CreatedAt:  now,
		LastActive: now,
	}
	return id
}

// Get returns a recording by ID, or nil if not found.
func (s *Store) Get(id string) *Recording {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rec := s.recordings[id]
	if rec == nil {
		return nil
	}
	// Return a copy to avoid data races
	copy := *rec
	copy.Captures = append([]CaptureEntry{}, rec.Captures...)
	return &copy
}

// SetStatus updates the status of a recording.
// Returns false if the recording doesn't exist or is already terminal.
func (s *Store) SetStatus(id string, status Status) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec := s.recordings[id]
	if rec == nil || rec.Status.IsTerminal() {
		return false
	}
	rec.Status = status
	rec.LastActive = time.Now()
	return true
}

// AddCapture appends a capture entry to a recording.
// Returns false if the recording doesn't exist or is not recording.
func (s *Store) AddCapture(id string, entry CaptureEntry) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec := s.recordings[id]
	if rec == nil || rec.Status != StatusRecording {
		return false
	}
	rec.Captures = append(rec.Captures, entry)
	rec.LastActive = time.Now()
	return true
}

// Delete removes a recording from the store.
func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.recordings, id)
}

// List returns all recording IDs (for cleanup).
func (s *Store) List() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ids := make([]string, 0, len(s.recordings))
	for id := range s.recordings {
		ids = append(ids, id)
	}
	return ids
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
