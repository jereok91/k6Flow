// Package lifecycle manages recording session cleanup and shutdown.
package lifecycle

import (
	"context"
	"log"
	"sync"
	"time"

	"k6flow/apps/recorder/internal/store"
)

// Config holds lifecycle manager configuration.
type Config struct {
	MaxDuration time.Duration
	Inactivity  time.Duration
	CheckPeriod time.Duration
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		MaxDuration: time.Hour,
		Inactivity:  5 * time.Minute,
		CheckPeriod: 30 * time.Second,
	}
}

// Manager handles recording lifecycle events.
type Manager struct {
	store  *store.Store
	config Config

	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
	running  bool
	onExpire func(id string, trigger string)
}

// New creates a new lifecycle manager.
func New(st *store.Store, cfg Config) *Manager {
	return &Manager{
		store:  st,
		config: cfg,
		done:   make(chan struct{}),
	}
}

// OnExpire sets a callback for when recordings expire.
func (m *Manager) OnExpire(fn func(id string, trigger string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onExpire = fn
}

// Start begins the lifecycle check loop.
func (m *Manager) Start() {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.running = true
	m.done = make(chan struct{})
	m.mu.Unlock()

	go m.loop(ctx)
}

// Stop halts the lifecycle manager and cleans up all recordings.
func (m *Manager) Stop() {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.cancel()
	m.running = false
	m.mu.Unlock()

	<-m.done

	// Cleanup all non-terminal recordings on shutdown
	m.cleanupAll("closed")
}

func (m *Manager) loop(ctx context.Context) {
	defer close(m.done)

	ticker := time.NewTicker(m.config.CheckPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.check()
		}
	}
}

func (m *Manager) check() {
	now := time.Now()
	ids := m.store.List()

	for _, id := range ids {
		rec := m.store.Get(id)
		if rec == nil || rec.Status.IsTerminal() {
			continue
		}

		var trigger string

		// Check max duration
		if now.Sub(rec.CreatedAt) > m.config.MaxDuration {
			trigger = "max-duration"
		}

		// Check inactivity
		if trigger == "" && now.Sub(rec.LastActive) > m.config.Inactivity {
			trigger = "inactivity"
		}

		if trigger != "" {
			m.expire(id, trigger)
		}
	}
}

func (m *Manager) expire(id string, trigger string) {
	log.Printf("lifecycle: expiring recording %s (trigger: %s)", id, trigger)

	// Transition to failed state
	m.store.SetStatus(id, store.StatusFailed)

	m.mu.Lock()
	callback := m.onExpire
	m.mu.Unlock()

	if callback != nil {
		callback(id, trigger)
	}
}

func (m *Manager) cleanupAll(trigger string) {
	ids := m.store.List()
	for _, id := range ids {
		rec := m.store.Get(id)
		if rec != nil && !rec.Status.IsTerminal() {
			m.expire(id, trigger)
		}
	}
}

// MarkActive updates the last active timestamp for a recording.
// Call this when traffic is captured to prevent inactivity timeout.
func (m *Manager) MarkActive(id string) {
	rec := m.store.Get(id)
	if rec != nil && !rec.Status.IsTerminal() {
		// Touch the recording via a no-op status change
		// The store updates LastActive on any status change
		m.store.SetStatus(id, rec.Status)
	}
}
