// Command server runs the K6Flow orchestrator: the contract-04 runs REST API
// (internal/httpapi) over the run engine (internal/engine) and the real
// Docker runtime (internal/runtime). K6F2-05 wires the full stack, reconciles
// orphans from a previous process at startup and shuts down gracefully.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"k6flow/apps/orchestrator/internal/config"
	"k6flow/apps/orchestrator/internal/engine"
	"k6flow/apps/orchestrator/internal/httpapi"
	"k6flow/apps/orchestrator/internal/live"
	"k6flow/apps/orchestrator/internal/metrics"
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

// allowedOriginsEnv is the optional WebSocket Origin allowlist (K6F3-03).
// Like networkEnv it is read here in cmd/server — internal/config is frozen —
// and passed to live.New's Deps.AllowedOrigins. See allowedOriginsFromEnv.
const allowedOriginsEnv = "ORCHESTRATOR_ALLOWED_ORIGINS"

// wsCloseNormal is the parent-decided terminal close code for metrics
// subscribers: 1000 with an EMPTY reason and no terminal frame (that frame
// shape is a deferred capability). Used for per-run closes (OnRunFinished →
// CloseRun) and for shutdown (CloseAll).
const wsCloseNormal = 1000

// allowedOriginsFromEnv parses ORCHESTRATOR_ALLOWED_ORIGINS — a
// comma-separated list of origins, each trimmed. Documented semantics:
//
//   - empty or whitespace-only ⇒ nil: live keeps its default same-origin
//     CheckOrigin. In compose the browser origin is the WEB origin, which
//     differs from the proxy host, so K6F3-04 must set this variable to the
//     Next.js origin; until then direct same-origin dev keeps working.
//   - a non-empty value is fail-closed (no coercion, consistent with
//     config.Load): every entry must be an absolute http(s) URL with a host
//     and no path/query/fragment; ANY malformed entry (including empty
//     entries from stray commas) aborts startup with an error instead of
//     silently dropping it — a partial allowlist would 403 a production
//     proxy and a coerced one would weaken the origin gate.
func allowedOriginsFromEnv(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	entries := strings.Split(value, ",")
	origins := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			return nil, fmt.Errorf("%s: empty entry in %q", allowedOriginsEnv, value)
		}
		u, err := url.Parse(trimmed)
		if err != nil {
			return nil, fmt.Errorf("%s: malformed origin %q: %w", allowedOriginsEnv, trimmed, err)
		}
		scheme := strings.ToLower(u.Scheme)
		if scheme != "http" && scheme != "https" {
			return nil, fmt.Errorf("%s: origin %q must use http or https", allowedOriginsEnv, trimmed)
		}
		if u.Host == "" {
			return nil, fmt.Errorf("%s: origin %q has no host", allowedOriginsEnv, trimmed)
		}
		if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("%s: origin %q must not carry a path, query or fragment", allowedOriginsEnv, trimmed)
		}
		origins = append(origins, trimmed)
	}
	return origins, nil
}

// runCloser is the WS hub seam the sink adapter needs: the frame-sink
// contract plus the terminal close. *live.Server satisfies it.
type runCloser interface {
	metrics.FrameSink
	CloseRun(runID string, code int)
}

// sinkAdapter bridges the engine's live-metrics sink contract to the live
// WebSocket hub (DECISIONES K6F3-03). OnFrame delegates verbatim — the hub
// already implements metrics.FrameSink, so the adapter is NOT needed for
// frames; it exists only for the terminal side, where the signatures differ:
// the engine's optional engine.RunFinisher contract is OnRunFinished(runID)
// (defined in engine because internal/live is frozen), while the hub
// exposes CloseRun(runID, code). The adapter translates one into the other
// with the parent-decided close code 1000.
type sinkAdapter struct {
	hub runCloser
}

var (
	_ metrics.FrameSink  = (*sinkAdapter)(nil)
	_ engine.RunFinisher = (*sinkAdapter)(nil)
)

// OnFrame forwards a window frame to the hub (encode-once, non-blocking
// fan-out happens inside live).
func (a *sinkAdapter) OnFrame(frame metrics.MetricsFrame) { a.hub.OnFrame(frame) }

// OnRunFinished maps the engine's terminal notification to the hub's close:
// CloseRun(runID, 1000) — empty reason, no terminal frame. It fires after
// the last window frame was emitted and the store shows the terminal state
// (engine ordering, DECISIONES K6F3-03), so the client sees close 1000
// directly after its final frame.
func (a *sinkAdapter) OnRunFinished(runID string) { a.hub.CloseRun(runID, wsCloseNormal) }

// newRootHandler mounts both handler trees on one root mux: "/" serves the
// contract-04 API plus /healthz unchanged (the httpapi mux still owns its
// exact patterns, so routing and method rules are byte-identical), and
// "/ws/runs/" hands the whole WebSocket subtree — every method — to the live
// endpoint's own mux, whose "GET /ws/runs/{runId}" pattern then applies the
// K6F3-02 gate order (blank runId 404 → 401 auth → 404 unknown run → 405
// non-GET → upgrade). The bare "/ws/runs" path matches no prefix and falls
// to the API's 404, so it can never reach the upgrade path.
func newRootHandler(api http.Handler, ws http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", api)
	mux.Handle("/ws/runs/", ws)
	return mux
}

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
		Limits: httpapi.RunLimits{
			MaxVUs:       cfg.MaxVUsPerRun,
			MaxMemoryMiB: cfg.MaxMemoryMiBPerRun,
			MaxCPUMillis: cfg.MaxCPUMillisPerRun,
		},
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

	// Fail-closed origin allowlist (documented in allowedOriginsFromEnv):
	// a malformed value aborts startup before any socket is opened.
	allowedOrigins, err := allowedOriginsFromEnv(os.Getenv(allowedOriginsEnv))
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	store := runs.NewStore()
	// K6F3-03: the metrics WebSocket endpoint — token from SERVICE_TOKEN,
	// run existence from the store, Origin allowlist from
	// ORCHESTRATOR_ALLOWED_ORIGINS (empty ⇒ live's same-origin default).
	ws := live.New(live.Deps{
		Token:          cfg.ServiceToken,
		Lookup:         store,
		Logger:         logger,
		AllowedOrigins: allowedOrigins,
	})
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
		// K6F3-03: tap frames → hub broadcast; terminal run → CloseRun 1000.
		Sink: &sinkAdapter{hub: ws},
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

	// REST API + metrics WS on one root mux; /healthz stays byte-identical.
	srv := newHTTPServer(cfg.Addr, newRootHandler(newAPIHandler(cfg, store, eng, logger), ws.Handler()))

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
		// K6F3-03 hub shutdown: hijacked WebSocket connections are invisible
		// to http.Server.Shutdown, so subscribers are closed explicitly with
		// 1000 (empty reason, no terminal frame) instead of dying with the
		// process. In-flight runs' subscribers were already closed by
		// OnRunFinished when their runs terminalized.
		ws.CloseAll(wsCloseNormal)
		if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped with error", "error", err)
		}
	}
}
