package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"

	"k6flow/apps/orchestrator/internal/runs"
)

// maxSafeInt is the JavaScript safe-integer ceiling declared by contract 04.
const maxSafeInt = 1<<53 - 1

// startConfig mirrors runStartConfigSchema: strict fields, version literal 1.
// RawMessage defers numeric checks to positiveSafeInt / jsonIsOne.
type startConfig struct {
	Version     json.RawMessage `json:"version"`
	Script      string          `json:"script"`
	VUs         json.RawMessage `json:"vus"`
	DurationMs  json.RawMessage `json:"durationMs"`
	CPUMillis   json.RawMessage `json:"cpuMillis"`
	MemoryMiB   json.RawMessage `json:"memoryMiB"`
	Attachments []attachment    `json:"attachments"`
}

type attachment struct {
	ID string `json:"id"`
}

// startRequest is the validated, storage-ready form of a run start body.
type startRequest struct {
	Script      string
	VUs         int
	DurationMs  int
	CPUMillis   int
	MemoryMiB   int
	Attachments []string
}

// decodeStart strictly validates one run start body: unknown fields, trailing
// content, a non-literal version, blank script, non-positive or unsafe
// integers, and blank attachment ids are all rejected.
func decodeStart(raw []byte) (startRequest, error) {
	var wire startConfig
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wire); err != nil {
		return startRequest{}, err
	}
	if err := dec.Decode(&json.RawMessage{}); err != io.EOF {
		return startRequest{}, errors.New("trailing content after the JSON object")
	}
	if !jsonIsOne(wire.Version) {
		return startRequest{}, errors.New("version must be the literal 1")
	}
	if strings.TrimSpace(wire.Script) == "" {
		return startRequest{}, errors.New("script must be a nonblank string")
	}
	req := startRequest{Script: wire.Script}
	numbers := []struct {
		name string
		raw  json.RawMessage
		dst  *int
	}{
		{"vus", wire.VUs, &req.VUs},
		{"durationMs", wire.DurationMs, &req.DurationMs},
		{"cpuMillis", wire.CPUMillis, &req.CPUMillis},
		{"memoryMiB", wire.MemoryMiB, &req.MemoryMiB},
	}
	for _, field := range numbers {
		value, err := positiveSafeInt(field.raw)
		if err != nil {
			return startRequest{}, fmt.Errorf("%s: %w", field.name, err)
		}
		*field.dst = value
	}
	for _, item := range wire.Attachments {
		if strings.TrimSpace(item.ID) == "" {
			return startRequest{}, errors.New("attachment id must be a nonblank string")
		}
		req.Attachments = append(req.Attachments, item.ID)
	}
	return req, nil
}

// jsonIsOne reports whether raw is a JSON number equal to 1 (Zod literal parity).
func jsonIsOne(raw json.RawMessage) bool {
	var value float64
	return len(raw) > 0 && json.Unmarshal(raw, &value) == nil && value == 1
}

// positiveSafeInt enforces contract 04 integers: whole, >= 1, <= 2^53-1.
func positiveSafeInt(raw json.RawMessage) (int, error) {
	if len(raw) == 0 {
		return 0, errors.New("required field missing")
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, errors.New("not a JSON number")
	}
	if value != math.Trunc(value) || value < 1 || value > maxSafeInt {
		return 0, errors.New("not a positive safe integer")
	}
	parsed := int(value)
	if int64(parsed) != int64(value) {
		return 0, errors.New("integer out of range")
	}
	return parsed, nil
}

// startRun answers 202 with a fresh runId, or 200 with the existing runId on an
// identical Idempotency-Key + payload hash (SHA-256 over the raw body bytes).
func (h *handler) startRun(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		h.logger.Warn("unreadable run start body", "path", r.URL.Path, "error", err)
		writeError(w, http.StatusBadRequest, codeInvalidRequest, msgInvalidRequest)
		return
	}
	req, err := decodeStart(raw)
	if err != nil {
		h.logger.Warn("rejected invalid run start", "path", r.URL.Path, "error", err)
		writeError(w, http.StatusBadRequest, codeInvalidRequest, msgInvalidRequest)
		return
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	key := r.Header.Get("Idempotency-Key")
	if key != "" {
		if id, ok := h.store.FindByDedupe(key, hash); ok {
			h.logger.Info("replayed run start", "runId", id)
			writeJSON(w, http.StatusOK, runRef{Version: contractVersion, RunID: id})
			return
		}
	}
	run, err := h.store.Create(runs.Run{
		Script:         req.Script,
		VUs:            req.VUs,
		DurationMs:     req.DurationMs,
		CPUMillis:      req.CPUMillis,
		MemoryMiB:      req.MemoryMiB,
		Attachments:    req.Attachments,
		IdempotencyKey: key,
		PayloadHash:    hash,
	})
	if err != nil {
		h.logger.Error("run store create failed", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, msgInternal)
		return
	}
	// K6F2-05: the synchronous pending -> running placeholder is gone. The
	// store keeps the run pending, the 202 is answered first, and Launch runs
	// on its own goroutine with a context detached from the request (the
	// request context is canceled as soon as the response is written). A
	// Launch error observed here is logged only — terminalizing the run is
	// the engine's own failure path (engine.failLaunch ⇒ failed).
	ctx := context.WithoutCancel(r.Context())
	h.logger.Info("run accepted", "runId", run.ID)
	writeJSON(w, http.StatusAccepted, runRef{Version: contractVersion, RunID: run.ID})
	go func() {
		if err := h.launcher.Launch(ctx, run.ID); err != nil {
			h.logger.Error("async launch failed", "runId", run.ID, "error", err)
		}
	}()
}

// stopRun answers 202 for any known run (terminal states are idempotent), 404
// for unknown runIds. For non-terminal runs it always asks the launcher to
// stop the container; the store transition depends on who owns finalization:
// a run the engine launched (status running) is terminalized by the engine's
// completion goroutine together with its stopped-run summary, while a still
// pending run (never launched, or launch not yet promoted) is terminalized
// here so every known non-terminal run converges to stopped.
func (h *handler) stopRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("runId")
	run, ok := h.store.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	if !isTerminal(run.Status) {
		ctx := context.WithoutCancel(r.Context())
		if err := h.launcher.Stop(ctx, id); err != nil {
			// 202 semantics are unchanged: a failed engine stop is logged and
			// the engine's completion path still converges the run later.
			h.logger.Warn("engine stop failed", "runId", id, "error", err)
		}
		cur, ok := h.store.Get(id)
		if ok && cur.Status == runs.StatusPending {
			if h.store.SetStatus(id, runs.StatusRunning) != nil {
				h.logger.Warn("pending promotion before stop failed", "runId", id)
			}
			if err := h.store.SetStatus(id, runs.StatusStopped); err != nil {
				// The engine may have terminalized the run in between; a
				// terminal run is success, anything else is a real failure.
				if now, nowOK := h.store.Get(id); !nowOK || !isTerminal(now.Status) {
					h.logger.Error("stop transition failed", "runId", id, "error", err)
					writeError(w, http.StatusInternalServerError, codeInternal, msgInternal)
					return
				}
			}
			h.logger.Info("run stopped", "runId", id)
		} else {
			h.logger.Info("run stop requested", "runId", id)
		}
	}
	writeJSON(w, http.StatusAccepted, runRef{Version: contractVersion, RunID: id})
}

// getRun answers 200 with the current run state, 404 for unknown runIds.
func (h *handler) getRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("runId")
	run, ok := h.store.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Version int    `json:"version"`
		RunID   string `json:"runId"`
		Status  string `json:"status"`
	}{Version: contractVersion, RunID: run.ID, Status: string(run.Status)})
}

// getSummary answers 200 with the stored terminal summary, 404 for unknown
// runIds, and 409 summary-not-terminal while the run is nonterminal or its
// summary is not yet available.
func (h *handler) getSummary(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("runId")
	run, ok := h.store.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	if run.Summary == nil || !isTerminal(run.Status) {
		writeError(w, http.StatusConflict, codeSummaryNotTerminal, msgSummaryNotTerminal)
		return
	}
	response := summaryBody{
		Version: contractVersion,
		RunID:   run.ID,
		Totals: totals{
			Requests:     run.Summary.Totals.Requests,
			Errors:       run.Summary.Totals.Errors,
			FailedChecks: run.Summary.Totals.FailedChecks,
			Iterations:   run.Summary.Totals.Iterations,
		},
		Latency: latency{
			AvgMs: run.Summary.LatencyMs.Avg,
			P90Ms: run.Summary.LatencyMs.P90,
			P95Ms: run.Summary.LatencyMs.P95,
			P99Ms: run.Summary.LatencyMs.P99,
		},
		Status:       string(run.Status),
		DataReceived: run.Summary.DataReceived,
		DataSent:     run.Summary.DataSent,
	}
	if run.Status == runs.StatusFinished {
		passed := run.Summary.ThresholdsPassed
		response.ThresholdsPassed = &passed
	}
	writeJSON(w, http.StatusOK, response)
}

// summaryBody mirrors RunSummary; thresholdsPassed appears only for finished.
type summaryBody struct {
	Version          int     `json:"version"`
	RunID            string  `json:"runId"`
	Totals           totals  `json:"totals"`
	Latency          latency `json:"latency"`
	Status           string  `json:"status"`
	ThresholdsPassed *bool   `json:"thresholdsPassed,omitempty"`
	DataReceived     int64   `json:"dataReceivedBytes"`
	DataSent         int64   `json:"dataSentBytes"`
}

type totals struct {
	Requests     int64 `json:"requests"`
	Errors       int64 `json:"errors"`
	FailedChecks int64 `json:"failedChecks"`
	Iterations   int64 `json:"iterations"`
}

type latency struct {
	AvgMs float64 `json:"avgMs"`
	P90Ms float64 `json:"p90Ms"`
	P95Ms float64 `json:"p95Ms"`
	P99Ms float64 `json:"p99Ms"`
}

// isTerminal reports membership in the closed terminal set finished|failed|stopped.
func isTerminal(status runs.Status) bool {
	return status == runs.StatusFinished || status == runs.StatusFailed || status == runs.StatusStopped
}
