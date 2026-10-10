// Package httpapi implements the contract-04 runs REST handlers (K6F2-02).
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
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
	// Per-run resource ceilings (422, see RunLimits).
	codeVUsLimitExceeded    = "vus-limit-exceeded"
	codeMemoryLimitExceeded = "memory-limit-exceeded"
	codeCPULimitExceeded    = "cpu-limit-exceeded"
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

// EnvLauncher is the optional env-capable extension of RunLauncher
// (k6flow-variables V-T3): *engine.Engine implements it. A start carrying
// `env` requires it; env is handed over in memory and never stored.
type EnvLauncher interface {
	LaunchWithEnv(ctx context.Context, runID string, env map[string]string) error
}

// Deps are the constructor dependencies. Logger defaults to slog.Default;
// Launcher is the engine (required, see RunLauncher) wired by tests with a
// fake and consumed by startRun/stopRun — this unit never talks to containers.
type Deps struct {
	Token    string
	Store    *runs.Store
	Launcher RunLauncher
	Logger   *slog.Logger
	Limits   RunLimits
}

// RunLimits are the per-run ceilings checked by start and preflight after
// body validation. Each limit is inclusive; a non-positive value disables
// that check (config.Load always supplies positive values in production).
type RunLimits struct {
	MaxVUs, MaxMemoryMiB, MaxCPUMillis int
}

// limitError is a rejected-ceiling outcome mapped to 422 by the handlers.
type limitError struct {
	code, message string
}

// check returns the first exceeded ceiling for req, or nil when within limits.
func (l RunLimits) check(req startRequest) *limitError {
	switch {
	case l.MaxVUs > 0 && req.VUs > l.MaxVUs:
		return &limitError{codeVUsLimitExceeded, fmt.Sprintf(
			"requested %d VUs exceeds the per-run limit of %d (MAX_VUS_PER_RUN)", req.VUs, l.MaxVUs)}
	case l.MaxMemoryMiB > 0 && req.MemoryMiB > l.MaxMemoryMiB:
		return &limitError{codeMemoryLimitExceeded, fmt.Sprintf(
			"requested %d MiB memory exceeds the per-run limit of %d MiB (MAX_MEMORY_MIB_PER_RUN)", req.MemoryMiB, l.MaxMemoryMiB)}
	case l.MaxCPUMillis > 0 && req.CPUMillis > l.MaxCPUMillis:
		return &limitError{codeCPULimitExceeded, fmt.Sprintf(
			"requested %d mCPU exceeds the per-run limit of %d mCPU (MAX_CPU_MILLIS_PER_RUN)", req.CPUMillis, l.MaxCPUMillis)}
	}
	return nil
}

type handler struct {
	store    *runs.Store
	launcher RunLauncher
	token    string
	logger   *slog.Logger
	limits   RunLimits
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
	h := &handler{store: deps.Store, launcher: deps.Launcher, token: deps.Token, logger: logger, limits: deps.Limits}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("POST /api/runs/preflight", h.preflight)
	mux.HandleFunc("GET /api/runs", h.listRuns)
	mux.HandleFunc("GET /api/runs/active", h.listActiveRuns)
	mux.HandleFunc("POST /api/runs", h.startRun)
	mux.HandleFunc("GET /api/runs/{runId}", h.getRun)
	mux.HandleFunc("POST /api/runs/{runId}/stop", h.stopRun)
	mux.HandleFunc("GET /api/runs/{runId}/summary", h.getSummary)
	mux.HandleFunc("GET /api/runs/{runId}/diagnostic", h.getDiagnostic)
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
