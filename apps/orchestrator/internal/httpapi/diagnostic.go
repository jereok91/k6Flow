package httpapi

import (
	"net/http"

	"k6flow/apps/orchestrator/internal/diagnostic"
)

// getDiagnostic obtains status, metadata and trace from one locked store read.
// Browser history and metric WebSocket delivery are never authoritative.
func (h *handler) getDiagnostic(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	run, ok := h.store.Get(r.PathValue("runId"))
	if !ok {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	if run.Trace == nil {
		writeError(w, http.StatusConflict, codeInvalidRequest, msgInvalidRequest)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Version    int                  `json:"version"`
		RunID      string               `json:"runId"`
		Status     string               `json:"status"`
		Diagnostic *diagnostic.Metadata `json:"diagnostic"`
		Trace      *diagnostic.Snapshot `json:"trace"`
	}{contractVersion, run.ID, string(run.Status), run.Diagnostic, run.Trace})
}
