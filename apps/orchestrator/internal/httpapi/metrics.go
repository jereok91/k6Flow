package httpapi

import (
	"net/http"

	"k6flow/apps/orchestrator/internal/metrics"
)

// FrameSource is the optional live-metrics dependency: *live.Server satisfies
// it via LastFrame, so this package never imports internal/live (the hub owns
// the WebSocket, this package owns REST). Nil means "no snapshot available".
type FrameSource interface {
	LastFrame(runID string) (metrics.MetricsFrame, bool)
}

// getRunMetrics serves the latest window frame the live hub received for a run:
// the polling fallback for the metrics WebSocket. The body is the frame's own
// contract encoding (metrics.MetricsFrame.EncodeJSON), so the REST payload and
// the `tick` frame carry one shape. 404 is the only "no snapshot" answer — the
// run is unknown here or has not closed a window yet — and the panel then keeps
// polling status only.
func (h *handler) getRunMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	runID := r.PathValue("runId")
	if h.frames == nil {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	frame, ok := h.frames.LastFrame(runID)
	if !ok {
		writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	data, err := frame.EncodeJSON()
	if err != nil {
		// Unreachable for the contract-fixed frame, handled rather than ignored.
		writeError(w, http.StatusInternalServerError, codeInternal, msgInternal)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
