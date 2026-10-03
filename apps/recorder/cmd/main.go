// Package main is the entry point for the K6Flow recorder service.
package main

import (
	"fmt"
	"log"
	"net/http"

	"k6flow/apps/recorder/internal/config"
	"k6flow/apps/recorder/internal/httpapi"
	"k6flow/apps/recorder/internal/store"
)

func main() {
	cfg := config.Load()
	st := store.New()
	srv := httpapi.NewServer(st, cfg.AuthToken)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", srv.HandleHealthz)
	mux.HandleFunc("POST /api/recorder/recordings", srv.HandleCreateRecording)
	mux.HandleFunc("GET /api/recorder/recordings/{id}", srv.HandleGetRecording)
	mux.HandleFunc("POST /api/recorder/recordings/{id}/stop", srv.HandleStopRecording)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("recorder: listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("recorder: %v", err)
	}
}
