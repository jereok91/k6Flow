// Package httpapi provides HTTP handlers for the recorder service.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"k6flow/apps/recorder/internal/store"
)

const apiVersion = 1

// Server holds dependencies for HTTP handlers.
type Server struct {
	store     *store.Store
	authToken string
}

// NewServer creates a new HTTP server with the given store and auth token.
func NewServer(s *store.Store, authToken string) *Server {
	return &Server{store: s, authToken: authToken}
}

// --- Response types ---

type healthResponse struct {
	Status string `json:"status"`
}

type createRequest struct {
	Version int `json:"version"`
}

type createResponse struct {
	Version     int    `json:"version"`
	RecordingID string `json:"recordingId"`
}

type stateResponse struct {
	Version     int    `json:"version"`
	RecordingID string `json:"recordingId"`
	Status      string `json:"status"`
}

type stopResponse struct {
	Version     int                  `json:"version"`
	RecordingID string               `json:"recordingId"`
	Status      string               `json:"status"`
	Capture     []store.CaptureEntry `json:"capture"`
}

type errorResponse struct {
	Version int    `json:"version"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// --- Handlers ---

// HandleHealthz returns 200 OK with {"status":"ok"}.
func (s *Server) HandleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
}

// HandleCreateRecording creates a new recording session.
// POST /api/recorder/recordings
func (s *Server) HandleCreateRecording(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid-request", "Invalid JSON body")
		return
	}

	if req.Version != apiVersion {
		s.writeError(w, http.StatusBadRequest, "invalid-version", "Expected version 1")
		return
	}

	id := s.store.Create()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(createResponse{
		Version:     apiVersion,
		RecordingID: id,
	})
}

// HandleGetRecording returns the state of a recording.
// GET /api/recorder/recordings/{id}
func (s *Server) HandleGetRecording(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	id := extractRecordingID(r.URL.Path)
	if id == "" {
		s.writeError(w, http.StatusBadRequest, "invalid-request", "Missing recording ID")
		return
	}

	rec := s.store.Get(id)
	if rec == nil {
		s.writeError(w, http.StatusNotFound, "recording-not-found", "Recording not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(stateResponse{
		Version:     apiVersion,
		RecordingID: rec.ID,
		Status:      string(rec.Status),
	})
}

// HandleStopRecording stops a recording and returns captures.
// POST /api/recorder/recordings/{id}/stop
func (s *Server) HandleStopRecording(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	// Extract ID from path like /api/recorder/recordings/{id}/stop
	path := r.URL.Path
	path = strings.TrimSuffix(path, "/stop")
	id := extractRecordingID(path)
	if id == "" {
		s.writeError(w, http.StatusBadRequest, "invalid-request", "Missing recording ID")
		return
	}

	rec := s.store.Get(id)
	if rec == nil {
		s.writeError(w, http.StatusNotFound, "recording-not-found", "Recording not found")
		return
	}

	// Idempotent stop: if already terminal, just return current state
	if !rec.Status.IsTerminal() {
		s.store.SetStatus(id, store.StatusStopping)
		s.store.SetStatus(id, store.StatusCompleted)
		rec = s.store.Get(id)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(stopResponse{
		Version:     apiVersion,
		RecordingID: rec.ID,
		Status:      string(rec.Status),
		Capture:     rec.Captures,
	})
}

// --- Helpers ---

func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.authToken == "" {
		return true // No auth configured
	}

	auth := r.Header.Get("Authorization")
	if auth == "" {
		s.writeError(w, http.StatusUnauthorized, "unauthorized", "Missing authorization header")
		return false
	}

	if !strings.HasPrefix(auth, "Bearer ") {
		s.writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid authorization format")
		return false
	}

	token := strings.TrimPrefix(auth, "Bearer ")
	if token != s.authToken {
		s.writeError(w, http.StatusUnauthorized, "unauthorized", "Invalid token")
		return false
	}

	return true
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse{
		Version: apiVersion,
		Code:    code,
		Message: message,
	})
}

func extractRecordingID(path string) string {
	// Path format: /api/recorder/recordings/{id}
	const prefix = "/api/recorder/recordings/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	id := strings.TrimPrefix(path, prefix)
	// Remove any trailing path segments
	if idx := strings.Index(id, "/"); idx != -1 {
		id = id[:idx]
	}
	return id
}
