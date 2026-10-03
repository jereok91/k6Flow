// Package httpapi provides HTTP handlers for the recorder service.
package httpapi

import (
	"encoding/json"
	"net/http"
)

// healthResponse is the JSON body for GET /healthz.
type healthResponse struct {
	Status string `json:"status"`
}

// HandleHealthz returns 200 OK with {"status":"ok"}.
func HandleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
}
