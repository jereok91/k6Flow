// Command server runs the K6Flow orchestrator: the contract-04 runs REST API
// (internal/httpapi) over the run engine (internal/engine) and the real
// Docker runtime (internal/runtime). K6F2-05 wires the full stack, reconciles
// orphans from a previous process at startup and shuts down gracefully.
package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"k6flow/apps/orchestrator/internal/config"
	"k6flow/apps/orchestrator/internal/engine"
	"k6flow/apps/orchestrator/internal/httpapi"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// Server timeouts and shutdown/reconciliation budgets.
const (
	readHeaderTimeout = 5 * time.Second
	writeTimeout      = 10 * time.Second
	idleTimeout       = 60 * time.Second
	// shutdownTimeout bounds http.Server.Shutdown: in-flight HTTP requests
	// get this long to finish; run containers are NOT drained here (see
	// stop below and docs/DECISIONES.md — Phase 9 owns deeper drain).
	shutdownTimeout = 10 * time.Second
	// reconcileTimeout bounds the startup orphan sweep; on timeout or any
	// other error the server still serves (logged, documented).
	reconcileTimeout = 30 * time.Second
)

// networkEnv is the optional Docker network for run containers. It is read
// here in cmd/server — not through internal/config, which is frozen for this
// unit — and applied by the decorated runtime: empty means the engine default
// (Spec.Network stays empty, Docker's default network applies).
const networkEnv = "ORCHESTRATOR_NETWORK"

// newAPIHandler wires config-driven Bearer auth (SERVICE_TOKEN, fail-closed
// inside httpapi), the run store and the engine-backed launcher into the
// contract-04 handler. /healthz stays public and byte-identical to the
// Phase 1 probe (asserted in main_test.go).
func newAPIHandler(cfg config.Config, store *runs.Store, launcher httpapi.RunLauncher, logger *slog.Logger) http.Handler {
	return httpapi.NewHandler(httpapi.Deps{
		Token:    cfg.ServiceToken,
		Store:    store,
		Launcher: launcher,
		Logger:   logger,
	})
}

// newHTTPServer keeps server construction and timeout ownership in cmd/server
// (httpapi returns a bare http.Handler). Timeouts match the Phase 1 server.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}
}

// newLogger builds the slog JSON logger at the configured level (config.Load
// already validated LOG_LEVEL against the closed set; unknown falls back to
// info). Secrets and scripts never reach this logger (httpapi/engine rules).
func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}

// decoratedRuntime applies the two K6F2-05 main-level wirings on top of the
// frozen DockerRuntime without editing it:
//
//   - Create fills Spec.Network from ORCHESTRATOR_NETWORK when the spec has
//     none (an explicit engine-provided network always wins; empty config
//     leaves the engine default untouched) and injects k6's --quiet so the
//     JSON-LINES stream stays uncorrupted (see withQuietFlag);
//   - Output strips Docker's multiplex framing (8-byte headers on every frame
//     of a non-TTY log stream — the containers the engine creates are all
//     non-TTY) and selects k6's JSON-LINES channel so k6sum receives pure
//     JSON instead of binary headers and banner chatter.
//
// Every other ContainerRuntime method delegates verbatim.
type decoratedRuntime struct {
	inner   runtime.ContainerRuntime
	network string
}

func newDecoratedRuntime(inner runtime.ContainerRuntime, network string) *decoratedRuntime {
	return &decoratedRuntime{inner: inner, network: network}
}

func (d *decoratedRuntime) Create(ctx context.Context, spec runtime.Spec) (string, error) {
	if spec.Network == "" {
		spec.Network = d.network // may stay empty: engine default
	}
	spec.Args = withQuietFlag(spec.Args)
	return d.inner.Create(ctx, spec)
}

// withQuietFlag injects k6's --quiet once. Conformance (K6F2-05, grafana/k6
// v2.3.0): progress output on STDOUT interleaves with the JSON-LINES points
// mid-line and corrupts them; --quiet disables progress and the banner, so
// only the end-of-run summary remains — always after the last point, where
// filterJSONLines drops it safely.
func withQuietFlag(args []string) []string {
	for _, arg := range args {
		if arg == "--quiet" {
			return args
		}
	}
	out := make([]string, 0, len(args)+1)
	out = append(out, "--quiet")
	out = append(out, args...)
	return out
}

// Output extracts k6's JSON-LINES channel from the raw container stream in
// two stages:
//
//  1. stdcopy strips Docker's multiplex framing (8-byte headers on every
//     frame of a non-TTY log stream) and drops stderr frames — k6's stderr
//     carries log lines that can echo script source;
//  2. filterJSONLines keeps only lines that open with '{': k6 v2.3 prints
//     its ASCII banner and end-of-run summary on STDOUT even with
//     `--out json` (no flag suppresses both — verified in K6F2-05), and
//     k6sum's fail-the-summary policy must never see non-JSON bytes.
//     Failures stay observable through the exit-code mapping in k6sum.
//
// Both goroutines unwind on consumer Close (pipe write fails ⇒ stdcopy stops
// ⇒ the raw stream is closed), and the engine only attaches Output after the
// container exited, so no read can block indefinitely.
func (d *decoratedRuntime) Output(ctx context.Context, containerID string) (io.ReadCloser, error) {
	raw, err := d.inner.Output(ctx, containerID)
	if err != nil {
		return nil, err
	}
	framed, frameWriter := io.Pipe()
	go func() {
		_, copyErr := stdcopy.StdCopy(frameWriter, io.Discard, raw)
		frameWriter.CloseWithError(copyErr)
		_ = raw.Close()
	}()
	pr, pw := io.Pipe()
	go func() { filterJSONLines(framed, pw) }()
	return pr, nil
}

// maxJSONLineBytes mirrors k6sum.MaxLineBytes: a longer line errors the
// stream exactly where k6sum's own guard would.
const maxJSONLineBytes = 1 << 20

// filterJSONLines copies only '{'-opening lines from src to dst and drops
// everything else (k6 banner/summary chatter). A scan error (oversized line
// or upstream framing failure) is propagated to the consumer.
func filterJSONLines(src io.ReadCloser, dst *io.PipeWriter) {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 64*1024), maxJSONLineBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		if _, err := dst.Write(line); err != nil {
			_ = src.Close()
			return // consumer closed the reader: unwind upstream
		}
		if _, err := dst.Write([]byte("\n")); err != nil {
			_ = src.Close()
			return
		}
	}
	_ = src.Close()
	dst.CloseWithError(scanner.Err())
}

func (d *decoratedRuntime) Start(ctx context.Context, containerID string) error {
	return d.inner.Start(ctx, containerID)
}

func (d *decoratedRuntime) Wait(ctx context.Context, containerID string) (int, error) {
	return d.inner.Wait(ctx, containerID)
}

func (d *decoratedRuntime) Stop(ctx context.Context, containerID string, timeout time.Duration) error {
	return d.inner.Stop(ctx, containerID, timeout)
}

func (d *decoratedRuntime) Remove(ctx context.Context, containerID string, force bool) error {
	return d.inner.Remove(ctx, containerID, force)
}

func (d *decoratedRuntime) ListLabeled(ctx context.Context) ([]string, error) {
	return d.inner.ListLabeled(ctx)
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stdout, nil)).Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	logger := newLogger(cfg.LogLevel)

	store := runs.NewStore()
	// The only place that constructs a real Docker client (K6F2-05); the
	// SDK client package was unfrozen for this unit (see go.mod pins).
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		logger.Error("docker client init failed", "error", err)
		os.Exit(1)
	}
	docker := runtime.NewDockerRuntime(cli, cfg, logger)
	rt := newDecoratedRuntime(docker, os.Getenv(networkEnv))
	eng := engine.New(engine.Deps{
		Store:   store,
		Runtime: rt,
		Sem:     runtime.NewSemaphore(cfg.MaxConcurrentRuns),
		K6Image: cfg.K6Image,
		Log:     logger,
	})

	// Startup orphan reconciliation: remove containers a previous process
	// left labeled. Failure (e.g. Docker down) is logged and the server
	// serves anyway — launches then fail per-run through the engine path.
	reconcileCtx, cancelReconcile := context.WithTimeout(context.Background(), reconcileTimeout)
	removed, recErr := docker.ReconcileOrphans(reconcileCtx)
	cancelReconcile()
	if recErr != nil {
		logger.Error("startup orphan reconciliation failed; continuing without it", "error", recErr)
	} else {
		logger.Info("startup orphan reconciliation finished", "removed", removed)
	}

	srv := newHTTPServer(cfg.Addr, newAPIHandler(cfg, store, eng, logger))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	logger.Info("orchestrator listening", "addr", cfg.Addr)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		// Graceful shutdown: drain HTTP only. In-flight run containers are
		// left running with their k6flow labels for the next startup's
		// ReconcileOrphans; draining or killing them on shutdown is Phase 9.
		logger.Info("shutdown signal received; draining http server", "timeout", shutdownTimeout.String())
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelShutdown()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
		if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped with error", "error", err)
		}
	}
}
