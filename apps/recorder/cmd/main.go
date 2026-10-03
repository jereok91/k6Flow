// Package main is the entry point for the K6Flow recorder service.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k6flow/apps/recorder/internal/config"
	"k6flow/apps/recorder/internal/httpapi"
	"k6flow/apps/recorder/internal/lifecycle"
	"k6flow/apps/recorder/internal/proxy"
	"k6flow/apps/recorder/internal/store"
	"k6flow/apps/recorder/internal/wsapi"
)

func main() {
	cfg := config.Load()

	// Initialize components
	st := store.New()
	hub := wsapi.NewHub()

	httpSrv := httpapi.NewServer(st, cfg.AuthToken)
	wsSrv := wsapi.NewServer(hub, st, cfg.AuthToken)

	// Lifecycle manager
	lcfg := lifecycle.Config{
		MaxDuration: time.Duration(cfg.MaxDurationSec) * time.Second,
		Inactivity:  time.Duration(cfg.InactivitySec) * time.Second,
		CheckPeriod: 30 * time.Second,
	}
	lm := lifecycle.New(st, lcfg)
	lm.OnExpire(func(id string, trigger string) {
		wsSrv.BroadcastStatus(id, "failed")
		log.Printf("recording %s expired: %s", id, trigger)
	})

	// Create proxy that captures to store and broadcasts via WS
	var currentRecordingID string // Simple single-recording mode for now
	proxyHandler := proxy.New(func(entry store.CaptureEntry) {
		if currentRecordingID != "" {
			if st.AddCapture(currentRecordingID, entry) {
				wsSrv.BroadcastCapture(currentRecordingID, entry)
				lm.MarkActive(currentRecordingID)
			}
		}
	})

	// HTTP API mux
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /healthz", httpSrv.HandleHealthz)
	apiMux.HandleFunc("POST /api/recorder/recordings", func(w http.ResponseWriter, r *http.Request) {
		// Intercept to track current recording
		httpSrv.HandleCreateRecording(w, r)
		// After create, the last created recording becomes current
		ids := st.List()
		if len(ids) > 0 {
			currentRecordingID = ids[len(ids)-1]
			st.SetStatus(currentRecordingID, store.StatusRecording)
			wsSrv.BroadcastStatus(currentRecordingID, "recording")
		}
	})
	apiMux.HandleFunc("GET /api/recorder/recordings/{id}", httpSrv.HandleGetRecording)
	apiMux.HandleFunc("POST /api/recorder/recordings/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		httpSrv.HandleStopRecording(w, r)
		currentRecordingID = "" // Clear current on stop
	})
	apiMux.HandleFunc("/ws/recordings/", wsSrv.HandleWebSocket)

	// Start lifecycle manager
	lm.Start()

	// Start servers
	apiAddr := fmt.Sprintf(":%d", cfg.Port)
	proxyAddr := fmt.Sprintf(":%d", cfg.ProxyPort)

	apiServer := &http.Server{Addr: apiAddr, Handler: apiMux}
	proxyServer := &http.Server{Addr: proxyAddr, Handler: proxyHandler}

	go func() {
		log.Printf("recorder API: listening on %s", apiAddr)
		if err := apiServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("API server: %v", err)
		}
	}()

	go func() {
		log.Printf("recorder proxy: listening on %s", proxyAddr)
		if err := proxyServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("proxy server: %v", err)
		}
	}()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("recorder: shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	lm.Stop()
	_ = apiServer.Shutdown(ctx)
	_ = proxyServer.Shutdown(ctx)

	log.Println("recorder: stopped")
}
