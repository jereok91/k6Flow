package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/pkg/stdcopy"

	"k6flow/apps/orchestrator/internal/config"
	"k6flow/apps/orchestrator/internal/engine"
	"k6flow/apps/orchestrator/internal/live"
	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

// stubLauncher records Launch/Stop calls without doing anything (K6F2-05
// main-level tests exercise wiring, not execution).
type stubLauncher struct {
	mu       sync.Mutex
	launched []string
	stopped  []string
}

func (s *stubLauncher) Launch(_ context.Context, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.launched = append(s.launched, runID)
	return nil
}

func (s *stubLauncher) Stop(_ context.Context, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = append(s.stopped, runID)
	return nil
}

func testHandler(token string, buf *bytes.Buffer) http.Handler {
	return newAPIHandler(config.Config{ServiceToken: token}, runs.NewStore(), &stubLauncher{},
		slog.New(slog.NewTextHandler(buf, nil)))
}

func TestHealthReadiness(t *testing.T) {
	handler := testHandler(testToken, &bytes.Buffer{})
	for _, name := range []string{"initial probe", "repeated probe"} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			if got := response.Header().Get("Content-Type"); got != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", got)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode JSON: %v", err)
			}
			if len(body) != 1 || body["status"] != "ok" {
				t.Errorf("body = %v, want only status: ok", body)
			}
		})
	}
}

func TestRoutingBoundaries(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		status int
	}{
		{"unknown route", http.MethodGet, "/runs", http.StatusNotFound},
		{"health subpath", http.MethodGet, "/healthz/extra", http.StatusNotFound},
		{"unsupported method", http.MethodPost, "/healthz", http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			testHandler(testToken, &bytes.Buffer{}).ServeHTTP(response, httptest.NewRequest(tt.method, tt.path, nil))
			if response.Code != tt.status {
				t.Errorf("status = %d, want %d", response.Code, tt.status)
			}
		})
	}
}

// TestAPIHandlerTokenFromConfig proves cmd/server wires SERVICE_TOKEN through
// config into the Bearer check (fail-closed surface of httpapi).
func TestAPIHandlerTokenFromConfig(t *testing.T) {
	handler := testHandler(testToken, &bytes.Buffer{})
	request := httptest.NewRequest(http.MethodGet, "/api/runs/run-none", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Errorf("wrong token status = %d, want 401", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/runs/run-none", nil)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Errorf("valid token status = %d, want 404 run-not-found", response.Code)
	}
}

const testToken = "s3cr3t-t0ken-9f3a2b"

func TestNewHTTPServerTimeouts(t *testing.T) {
	srv := newHTTPServer(":0", http.NotFoundHandler())
	if srv.ReadHeaderTimeout != 5*time.Second || srv.WriteTimeout != 10*time.Second || srv.IdleTimeout != 60*time.Second {
		t.Errorf("timeouts = (read-header %v, write %v, idle %v), want (5s, 10s, 60s)",
			srv.ReadHeaderTimeout, srv.WriteTimeout, srv.IdleTimeout)
	}
	if srv.Handler == nil {
		t.Error("Handler = nil")
	}
}

func TestNewLoggerLevels(t *testing.T) {
	for _, level := range []string{"debug", "info", "warn", "error"} {
		t.Run(level, func(t *testing.T) {
			logger := newLogger(level)
			if logger == nil {
				t.Fatal("newLogger returned nil")
			}
			ctx := context.Background()
			want := map[string]slog.Level{
				"debug": slog.LevelDebug, "info": slog.LevelInfo,
				"warn": slog.LevelWarn, "error": slog.LevelError,
			}[level]
			if !logger.Handler().Enabled(ctx, want) {
				t.Errorf("level %s not enabled", want)
			}
			if logger.Handler().Enabled(ctx, want-1) {
				t.Errorf("level %d unexpectedly enabled", want-1)
			}
		})
	}
}

func TestDecoratedRuntimeFillsNetworkWhenConfigured(t *testing.T) {
	inner := runtime.NewFakeRuntime()
	rt := newDecoratedRuntime(inner, "k6flow-net")
	if _, err := rt.Create(context.Background(), runtime.Spec{Image: "img", CPUMillis: 100, MemoryMiB: 64}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	specs := inner.Specs()
	if len(specs) != 1 || specs[0].Network != "k6flow-net" {
		t.Errorf("specs = %+v, want one spec with Network k6flow-net", specs)
	}
}

// TestDecoratedRuntimeInjectsQuietFlag pins the k6 v2.3 conformance fix:
// progress/banner output on STDOUT interleaves with JSON points mid-line and
// corrupts the stream, so Create must inject --quiet (progress off, banner
// suppressed — only the end-of-run summary remains, at the stream boundary,
// where filterJSONLines drops it).
func TestDecoratedRuntimeInjectsQuietFlag(t *testing.T) {
	inner := runtime.NewFakeRuntime()
	rt := newDecoratedRuntime(inner, "")
	if _, err := rt.Create(context.Background(), runtime.Spec{
		Image: "img", Command: []string{"run"},
		Args:      []string{"--out", "json", "/k6flow/script.js"},
		CPUMillis: 100, MemoryMiB: 64,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	specs := inner.Specs()
	if len(specs) != 1 {
		t.Fatalf("specs = %d, want 1", len(specs))
	}
	want := []string{"--quiet", "--out", "json", "/k6flow/script.js"}
	if strings.Join(specs[0].Args, " ") != strings.Join(want, " ") {
		t.Errorf("Args = %v, want %v (--quiet injected once, before the script path)", specs[0].Args, want)
	}
}

func TestDecoratedRuntimeKeepsEngineDefaultWhenUnset(t *testing.T) {
	inner := runtime.NewFakeRuntime()
	rt := newDecoratedRuntime(inner, "")
	if _, err := rt.Create(context.Background(), runtime.Spec{Image: "img", CPUMillis: 100, MemoryMiB: 64}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if specs := inner.Specs(); len(specs) != 1 || specs[0].Network != "" {
		t.Errorf("specs = %+v, want Network left empty (engine default)", specs)
	}
}

func TestDecoratedRuntimeRespectsExplicitSpecNetwork(t *testing.T) {
	inner := runtime.NewFakeRuntime()
	rt := newDecoratedRuntime(inner, "configured-net")
	if _, err := rt.Create(context.Background(), runtime.Spec{Image: "img", Network: "engine-net", CPUMillis: 100, MemoryMiB: 64}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if specs := inner.Specs(); len(specs) != 1 || specs[0].Network != "engine-net" {
		t.Errorf("specs = %+v, want the explicit engine-net to win", specs)
	}
}

// TestDecoratedRuntimeDemuxesOutput round-trips real Docker-style
// multiplexed frames (8-byte header + payload, exactly what the daemon emits
// for the non-TTY containers the engine creates): the stdout JSON-LINES
// payload must arrive verbatim while k6's stdout banner/end-summary chatter
// and the stderr frame are dropped before k6sum can see them.
func TestDecoratedRuntimeDemuxesOutput(t *testing.T) {
	payload := `{"type":"Point","metric":"checks","data":{"value":0}}` + "\n"
	stdoutChunks := []string{
		`       /\      Grafana   /--/` + "\n", // k6 stdout banner (real streams have it)
		payload,
		"  █ TOTAL RESULTS\n", // k6 stdout end-of-run summary
	}
	stderrPayload := "level=warning msg=banner noise\n"
	var framed bytes.Buffer
	stdout := stdcopy.NewStdWriter(&framed, stdcopy.Stdout)
	for _, chunk := range stdoutChunks {
		if _, err := stdout.Write([]byte(chunk)); err != nil {
			t.Fatalf("frame stdout: %v", err)
		}
	}
	stderr := stdcopy.NewStdWriter(&framed, stdcopy.Stderr)
	if _, err := stderr.Write([]byte(stderrPayload)); err != nil {
		t.Fatalf("frame stderr: %v", err)
	}
	wantLen := len(stderrPayload) + 4*8
	for _, chunk := range stdoutChunks {
		wantLen += len(chunk)
	}
	if framed.Len() != wantLen {
		t.Fatalf("framed length = %d, want %d (chunks + four 8-byte headers)", framed.Len(), wantLen)
	}
	inner := runtime.NewFakeRuntime()
	inner.SetOutput("fake-1", framed.String())
	rt := newDecoratedRuntime(inner, "")
	reader, err := rt.Output(context.Background(), "fake-1")
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read filtered stream: %v", err)
	}
	if string(data) != payload {
		t.Errorf("filtered = %q, want exactly the stdout JSON-LINES payload (no framing, stderr, banner or summary)", data)
	}
}

func TestDecoratedRuntimeDelegatesLifecycle(t *testing.T) {
	inner := runtime.NewFakeRuntime()
	rt := newDecoratedRuntime(inner, "")
	ctx := context.Background()
	id, err := rt.Create(ctx, runtime.Spec{Image: "img", CPUMillis: 100, MemoryMiB: 64})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rt.Start(ctx, id); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := rt.Wait(ctx, id); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := rt.Stop(ctx, id, time.Second); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := rt.Remove(ctx, id, true); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := rt.ListLabeled(ctx); err != nil {
		t.Fatalf("ListLabeled: %v", err)
	}
	want := []string{"Create:" + id, "Start:" + id, "Wait:" + id, "Stop:" + id, "Remove:" + id, "ListLabeled"}
	got := inner.Calls()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v, want %v (verbatim delegation)", got, want)
	}
}

// --- K6F3-03: live-metrics wiring (env parsing, sink adapter, routing) ----

// TestAllowedOriginsFromEnv pins ORCHESTRATOR_ALLOWED_ORIGINS semantics:
// empty/whitespace keeps the live same-origin default (K6F3-04 sets the
// web origin later), a comma-separated list is trimmed entry by entry, and
// ANY malformed non-empty value fails closed at startup (error, no coercion,
// no silently-dropped entries — consistent with config.Load's strictness).
func TestAllowedOriginsFromEnv(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    []string
		wantErr bool
	}{
		{"empty keeps live default", "", nil, false},
		{"whitespace keeps live default", "   ", nil, false},
		{"single origin", "https://app.example", []string{"https://app.example"}, false},
		{"comma list trimmed per entry", " https://a.example , http://b.example:8080 ",
			[]string{"https://a.example", "http://b.example:8080"}, false},
		{"malformed not a url", "not a url", nil, true},
		{"malformed scheme-less host", "app.example.com", nil, true},
		{"malformed missing host", "https://", nil, true},
		{"malformed non-http scheme", "ftp://files.example", nil, true},
		{"malformed empty entry", "https://a.example,,https://b.example", nil, true},
		{"malformed bad escape", "http://%zz", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := allowedOriginsFromEnv(tt.value)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("allowedOriginsFromEnv(%q) error = nil, want fail-closed startup error", tt.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("allowedOriginsFromEnv(%q): %v", tt.value, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("origins = %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("origins[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// fakeRunCloser is the adapter's hub seam: metrics.FrameSink + CloseRun.
type fakeRunCloser struct {
	mu     sync.Mutex
	frames []metrics.MetricsFrame
	closed []closedRun
}

type closedRun struct {
	runID string
	code  int
}

func (f *fakeRunCloser) OnFrame(frame metrics.MetricsFrame) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, frame)
}

func (f *fakeRunCloser) CloseRun(runID string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = append(f.closed, closedRun{runID, code})
}

// TestSinkAdapterForwardsFramesAndClosesRun proves the adapter contract the
// engine consumes: frames pass through untouched and the terminal
// notification maps to hub CloseRun(runID, 1000) — the parent-decided close
// (empty reason, no terminal frame) lives at the adapter, so the frozen
// internal/live needs no OnRunFinished method.
func TestSinkAdapterForwardsFramesAndClosesRun(t *testing.T) {
	hub := &fakeRunCloser{}
	adapter := &sinkAdapter{hub: hub}
	// The engine injects the adapter through Deps.Sink: it must satisfy both
	// the FrameSink contract and the optional terminal-notification contract.
	var _ metrics.FrameSink = adapter
	var _ engine.RunFinisher = adapter

	frame := metrics.MetricsFrame{
		Version: 1, Type: "metrics", RunID: "run-adapter", Seq: 7,
		Window:    metrics.Window{StartMs: 7000, DurationMs: 1000},
		ActiveVUs: 2, FailedChecks: 1,
	}
	adapter.OnFrame(frame)
	adapter.OnRunFinished("run-adapter")

	hub.mu.Lock()
	frames, closed := append([]metrics.MetricsFrame(nil), hub.frames...), append([]closedRun(nil), hub.closed...)
	hub.mu.Unlock()
	if len(frames) != 1 || frames[0] != frame {
		t.Errorf("frames = %+v, want the frame forwarded verbatim", frames)
	}
	if len(closed) != 1 || closed[0] != (closedRun{"run-adapter", 1000}) {
		t.Errorf("closes = %+v, want exactly [{run-adapter 1000}]", closed)
	}
}

// TestRootHandlerMountsWebSocketAlongsideAPI proves the production routing:
// one root mux keeps /healthz and /api/* on the contract-04 handler and
// hands /ws/runs/* to the live endpoint with its documented gate order
// (401 auth before 404 lookup), 405 for non-GET, and a plain 404 for the
// blank run id. The exact /ws/runs path is the global runs feed, so an
// unauthenticated request is rejected 401 before any upgrade.
func TestRootHandlerMountsWebSocketAlongsideAPI(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := runs.NewStore()
	api := newAPIHandler(config.Config{ServiceToken: testToken}, store, &stubLauncher{}, logger)
	ws := live.New(live.Deps{Token: testToken, Lookup: store, Logger: logger})
	handler := newRootHandler(api, ws.Handler())

	tests := []struct {
		name      string
		method    string
		path      string
		protocol  string
		status    int
		bodyMatch string
	}{
		{"healthz passes through the root mux", http.MethodGet, "/healthz", "", http.StatusOK, `"status":"ok"`},
		{"api route still served by httpapi", http.MethodGet, "/api/runs/run-x", "", http.StatusUnauthorized, `"code":"unauthorized"`},
		{"ws wrong token rejected 401 pre-upgrade", http.MethodGet, "/ws/runs/run-x", "k6flow.bearer, wrong", http.StatusUnauthorized, `"code":"unauthorized"`},
		{"ws scheme-only offer rejected 401", http.MethodGet, "/ws/runs/run-x", "k6flow.bearer", http.StatusUnauthorized, `"code":"unauthorized"`},
		{"ws unknown run rejected 404", http.MethodGet, "/ws/runs/run-x", "k6flow.bearer, " + testToken, http.StatusNotFound, `"code":"run-not-found"`},
		{"ws runs feed rejects unauthenticated 401 pre-upgrade", http.MethodGet, "/ws/runs", "", http.StatusUnauthorized, `"code":"unauthorized"`},
		{"ws blank run id is 404 pre-upgrade", http.MethodGet, "/ws/runs/", "", http.StatusNotFound, ""},
		{"ws nested run id is 404", http.MethodGet, "/ws/runs/a/b", "", http.StatusNotFound, ""},
		{"ws non-GET rejected 405 by the live mux", http.MethodPost, "/ws/runs/run-x", "", http.StatusMethodNotAllowed, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(tt.method, tt.path, nil)
			if tt.protocol != "" {
				request.Header.Set("Sec-WebSocket-Protocol", tt.protocol)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tt.status {
				t.Fatalf("status = %d, want %d (body %q)", response.Code, tt.status, response.Body.String())
			}
			if tt.bodyMatch != "" && !strings.Contains(response.Body.String(), tt.bodyMatch) {
				t.Errorf("body = %q, want it to contain %q", response.Body.String(), tt.bodyMatch)
			}
		})
	}
}
