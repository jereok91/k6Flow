// Package main is the entry point for the K6Flow recorder service.
package main

import (
	"fmt"
	"log"
	"net/http"

	"k6flow/apps/recorder/internal/config"
	"k6flow/apps/recorder/internal/httpapi"
)

func main() {
	cfg := config.Load()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", httpapi.HandleHealthz)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("recorder: listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("recorder: %v", err)
	}
}
