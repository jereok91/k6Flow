// Package live messages defines the WebSocket message types for the executions module.
package live

import (
	"encoding/json"
	"time"

	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
)

// Message types for the WebSocket protocol
const (
	TypeHello    = "hello"    // Sent on connection with current state
	TypeSnapshot = "snapshot" // Initial or recovery state
	TypeTick     = "tick"     // Regular metrics frame (wraps MetricsFrame)
	TypeState    = "state"    // State change notification
	TypeEnd      = "end"      // Run ended notification
)

// HelloMessage is sent when a client connects.
type HelloMessage struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RunID     string `json:"runId"`
	Status    string `json:"status"`
	LastSeq   int64  `json:"lastSeq"`   // last emitted sequence number
	StartedAt *int64 `json:"startedAt"` // ms since epoch
	Elapsed   int64  `json:"elapsedMs"` // ms since start
}

// SnapshotMessage provides initial or recovery state.
type SnapshotMessage struct {
	Version       int                   `json:"version"`
	Type          string                `json:"type"`
	RunID         string                `json:"runId"`
	Status        string                `json:"status"`
	VUs           int                   `json:"vus"`
	DurationMs    int                   `json:"durationMs"`
	LastSeq       int64                 `json:"lastSeq"`
	ScenarioID    string                `json:"scenarioId,omitempty"`
	ScenarioName  string                `json:"scenarioName,omitempty"`
	Cumulative    *CumulativeStats      `json:"cumulative,omitempty"`
	RecentFrames  []metrics.MetricsFrame `json:"recentFrames,omitempty"` // for chart hydration
}

// CumulativeStats are the running totals.
type CumulativeStats struct {
	Requests     int64   `json:"requests"`
	Errors       int64   `json:"errors"`
	FailedChecks int64   `json:"failedChecks"`
	AvgLatencyMs float64 `json:"avgLatencyMs"`
}

// TickMessage wraps a metrics frame with the unified envelope.
type TickMessage struct {
	Version int                  `json:"version"`
	Type    string               `json:"type"`
	RunID   string               `json:"runId"`
	Seq     int64                `json:"seq"`
	Frame   metrics.MetricsFrame `json:"frame"`
}

// StateMessage notifies of a state transition.
type StateMessage struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RunID     string `json:"runId"`
	FromState string `json:"fromState"`
	ToState   string `json:"toState"`
	At        int64  `json:"at"` // ms since epoch
	Actor     string `json:"actor,omitempty"`
	Cause     string `json:"cause,omitempty"`
}

// EndMessage is sent when a run terminates.
type EndMessage struct {
	Version   int        `json:"version"`
	Type      string     `json:"type"`
	RunID     string     `json:"runId"`
	Status    string     `json:"status"`
	Result    string     `json:"result,omitempty"`
	ExitCode  int        `json:"exitCode"`
	Summary   *runs.Summary `json:"summary,omitempty"`
	FinishedAt int64     `json:"finishedAt"` // ms since epoch
}

// NewHelloMessage creates a hello message for a run.
func NewHelloMessage(run runs.Run, lastSeq int64) HelloMessage {
	msg := HelloMessage{
		Version: contractVersion,
		Type:    TypeHello,
		RunID:   run.ID,
		Status:  string(run.Status),
		LastSeq: lastSeq,
	}
	if run.StartedAt != nil {
		ms := run.StartedAt.UnixMilli()
		msg.StartedAt = &ms
		msg.Elapsed = time.Now().UnixMilli() - ms
	}
	return msg
}

// NewSnapshotMessage creates a snapshot message for a run.
func NewSnapshotMessage(run runs.Run, lastSeq int64, recentFrames []metrics.MetricsFrame) SnapshotMessage {
	return SnapshotMessage{
		Version:      contractVersion,
		Type:         TypeSnapshot,
		RunID:        run.ID,
		Status:       string(run.Status),
		VUs:          run.VUs,
		DurationMs:   run.DurationMs,
		LastSeq:      lastSeq,
		ScenarioID:   run.ScenarioID,
		ScenarioName: run.ScenarioName,
		RecentFrames: recentFrames,
	}
}

// NewTickMessage wraps a metrics frame.
func NewTickMessage(frame metrics.MetricsFrame) TickMessage {
	return TickMessage{
		Version: contractVersion,
		Type:    TypeTick,
		RunID:   frame.RunID,
		Seq:     frame.Seq,
		Frame:   frame,
	}
}

// NewStateMessage creates a state change notification.
func NewStateMessage(runID string, from, to runs.Status, at time.Time, actor, cause string) StateMessage {
	return StateMessage{
		Version:   contractVersion,
		Type:      TypeState,
		RunID:     runID,
		FromState: string(from),
		ToState:   string(to),
		At:        at.UnixMilli(),
		Actor:     actor,
		Cause:     cause,
	}
}

// NewEndMessage creates a run ended notification.
func NewEndMessage(run runs.Run) EndMessage {
	msg := EndMessage{
		Version:  contractVersion,
		Type:     TypeEnd,
		RunID:    run.ID,
		Status:   string(run.Status),
		Result:   string(run.Result),
		ExitCode: run.ExitCode,
		Summary:  run.Summary,
	}
	if run.FinishedAt != nil {
		msg.FinishedAt = run.FinishedAt.UnixMilli()
	}
	return msg
}

// Global runs feed (`GET /ws/runs`) message types.
const (
	TypeRunsSnapshot = "runs.snapshot" // sent once on connect
	TypeRunsState    = "runs.state"    // every run state transition (incl. creation)
	TypeRunsEnd      = "runs.end"      // run reached a terminal state
)

// RunItem is the run summary carried by the global runs feed. Its JSON shape
// mirrors httpapi's runListItem (GET /api/runs/active) so REST and feed
// consumers share one model; finishedAt only appears on terminal runs.
type RunItem struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ScenarioID   string `json:"scenarioId,omitempty"`
	ScenarioName string `json:"scenarioName,omitempty"`
	VUs          int    `json:"vus"`
	DurationMs   int    `json:"durationMs"`
	CreatedAt    int64  `json:"createdAt"`
	StartedAt    *int64 `json:"startedAt,omitempty"`
	FinishedAt   *int64 `json:"finishedAt,omitempty"`
}

// RunsSnapshotMessage lists the non-terminal runs (same split as
// GET /api/runs/active: queued vs everything else).
type RunsSnapshotMessage struct {
	Version int       `json:"version"`
	Type    string    `json:"type"`
	Active  []RunItem `json:"active"`
	Queued  []RunItem `json:"queued"`
}

// RunsStateMessage announces one run transition; FromState is empty for the
// creation event.
type RunsStateMessage struct {
	Version   int     `json:"version"`
	Type      string  `json:"type"`
	Run       RunItem `json:"run"`
	FromState string  `json:"fromState"`
	ToState   string  `json:"toState"`
	At        int64   `json:"at"` // ms since epoch
}

// RunsEndMessage announces a terminal run.
type RunsEndMessage struct {
	Version  int     `json:"version"`
	Type     string  `json:"type"`
	Run      RunItem `json:"run"`
	Status   string  `json:"status"`
	ExitCode int     `json:"exitCode"`
}

// NewRunItem projects a stored run onto the feed DTO.
func NewRunItem(run runs.Run) RunItem {
	item := RunItem{
		ID:           run.ID,
		Status:       string(run.Status),
		ScenarioID:   run.ScenarioID,
		ScenarioName: run.ScenarioName,
		VUs:          run.VUs,
		DurationMs:   run.DurationMs,
		CreatedAt:    run.CreatedAt.UnixMilli(),
		StartedAt:    msPtr(run.StartedAt),
	}
	if run.Status.IsTerminal() {
		item.FinishedAt = msPtr(run.FinishedAt)
	}
	return item
}

func msPtr(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	ms := t.UnixMilli()
	return &ms
}

// NewRunsSnapshotMessage splits non-terminal runs into active and queued.
func NewRunsSnapshotMessage(all []runs.Run) RunsSnapshotMessage {
	msg := RunsSnapshotMessage{
		Version: contractVersion,
		Type:    TypeRunsSnapshot,
		Active:  make([]RunItem, 0),
		Queued:  make([]RunItem, 0),
	}
	for _, run := range all {
		if run.Status.IsTerminal() {
			continue
		}
		if run.Status == runs.StatusQueued {
			msg.Queued = append(msg.Queued, NewRunItem(run))
		} else {
			msg.Active = append(msg.Active, NewRunItem(run))
		}
	}
	return msg
}

// NewRunsStateMessage builds a runs.state event.
func NewRunsStateMessage(run runs.Run, from, to runs.Status, at time.Time) RunsStateMessage {
	return RunsStateMessage{
		Version:   contractVersion,
		Type:      TypeRunsState,
		Run:       NewRunItem(run),
		FromState: string(from),
		ToState:   string(to),
		At:        at.UnixMilli(),
	}
}

// NewRunsEndMessage builds a runs.end event.
func NewRunsEndMessage(run runs.Run) RunsEndMessage {
	return RunsEndMessage{
		Version:  contractVersion,
		Type:     TypeRunsEnd,
		Run:      NewRunItem(run),
		Status:   string(run.Status),
		ExitCode: run.ExitCode,
	}
}

// EncodeMessage encodes any message to JSON bytes.
func EncodeMessage(msg any) ([]byte, error) {
	return json.Marshal(msg)
}
