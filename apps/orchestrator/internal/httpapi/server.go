// Package httpapi implements the contract-04 runs REST handlers (K6F2-02).
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"k6flow/apps/orchestrator/internal/runs"
)

// Contract version carried by every API body (versionEnvelopeSchema).
const contractVersion = 1

// Error catalog codes (runErrorCatalogSchema) plus the Phase 2 malformed-body
// and failure codes documented in docs/DECISIONES.md.
const (
	codeUnauthorized       = "unauthorized"
	codeRunNotFound        = "run-not-found"
	codeSummaryNotTerminal = "summary-not-terminal"
	codeInvalidRequest     = "invalid-request"
	codeInternal           = "internal"
)

const (
	msgUnauthorized       = "missing or invalid Authorization bearer token"
	msgRunNotFound        = "unknown runId"
	msgSummaryNotTerminal = "premature summary: run not in a terminal state"
	msgInvalidRequest     = "invalid request body"
	msgInternal           = "internal server error"
)

// RunLauncher is the run-execution dependency of the handlers, defined
// locally so the HTTP layer never imports the engine package: *engine.Engine
// satisfies it in cmd/server and tests substitute a fake. Launch returns once
// the container has started; every later failure terminalizes the run through
// the engine's own failure path. Stop requests a graceful stop so the engine's
// completion goroutine finalizes the run.
type RunLauncher interface {
	Launch(ctx context.Context, runID string) error
	Stop(ctx context.Context, runID string) error
}

// Deps are the constructor dependencies. Logger defaults to slog.Default;
// Launcher is the engine (required, see RunLauncher) wired by tests with a
// fake and consumed by startRun/stopRun — this unit never talks to containers.
type Deps struct {
	Token    string
	Store    *runs.Store
	Launcher RunLauncher
	Logger   *slog.Logger
}

type handler struct {
	store    *runs.Store
	launcher RunLauncher
	token    string
	logger   *slog.Logger
}

// NewHandler wires contract 04: static Bearer auth on every /api/* route, the
// five runs endpoints, and the public unversioned /healthz preserved byte for
// byte. It returns an http.Handler rather than *http.Server so cmd/server keeps
// server construction and timeout ownership.
func NewHandler(deps Deps) http.Handler {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	h := &handler{store: deps.Store, launcher: deps.Launcher, token: deps.Token, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("POST /api/runs/preflight", h.preflight)
	mux.HandleFunc("GET /api/runs", h.listRuns)
	mux.HandleFunc("GET /api/runs/active", h.listActiveRuns)
	mux.HandleFunc("POST /api/runs", h.startRun)
	mux.HandleFunc("GET /api/runs/{runId}", h.getRun)
	mux.HandleFunc("POST /api/runs/{runId}/stop", h.stopRun)
	mux.HandleFunc("GET /api/runs/{runId}/summary", h.getSummary)
	mux.HandleFunc("GET /api/runs/{runId}/endpoints", h.getEndpoints)
	mux.HandleFunc("GET /api/runs/{runId}/failures", h.getFailures)
	mux.HandleFunc("POST /api/runs/emergency-stop", h.emergencyStop)
	return h.authorize(mux)
}

// authorize guards /api/* only; /healthz stays public and unversioned.
func (h *handler) authorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path != "/api" && !strings.HasPrefix(path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if !h.bearerValid(r.Header.Get("Authorization")) {
			h.logger.Warn("unauthorized request", "method", r.Method, "path", path)
			writeError(w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bearerValid compares the static Bearer token in constant time. An empty
// configured token fails closed: every /api/* request is rejected (config.Load).
func (h *handler) bearerValid(header string) bool {
	scheme, token, found := strings.Cut(header, " ")
	if !found || scheme != "Bearer" || token == "" || h.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(h.token)) == 1
}

// healthz preserves the Phase 1 process probe exactly: public, unversioned,
// no-store JSON. cmd/server keeps its own copy until it wires NewHandler.
func (h *handler) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}

// errorBody is the flat contract error envelope (runErrorResponseSchema).
type errorBody struct {
	Version int    `json:"version"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// runRef is the RunReference body returned by start and stop.
type runRef struct {
	Version int    `json:"version"`
	RunID   string `json:"runId"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Version: contractVersion, Code: code, Message: message})
}
