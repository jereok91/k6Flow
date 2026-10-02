package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k6flow/apps/orchestrator/internal/runs"
)

const (
	testToken  = "s3cr3t-t0ken-9f3a2b"
	testScript = "import http from 'k6/http'; export default function () {}"
	scriptJSON = "\"script\":\"" + testScript + "\""
	validStart = `{"version":1,"script":"` + testScript + `","vus":10,"durationMs":5000,"cpuMillis":500,"memoryMiB":256}`
)

// launchGateTimeout bounds the fake's async gate so a hypothetical
// synchronous implementation fails the async test quickly instead of hanging
// the suite.
const launchGateTimeout = 3 * time.Second

// fakeLauncher implements RunLauncher with engine-like semantics: Launch
// promotes pending -> running after an optional gate (so asynchronous launches
// are provable), Stop finalizes a non-terminal run as stopped (the engine's
// completion-path contract). Errors, the gate and Stop's finalize behavior are
// injectable; entry/completion are observable via channels.
type fakeLauncher struct {
	store     *runs.Store
	gate      chan struct{}
	launchErr error
	stopErr   error
	onStop    func(runID string) // overrides the default finalize

	launched  chan string
	completed chan string
	stopCalls chan string
	launches  atomic.Int32
	stops     atomic.Int32
}

func newFakeLauncher(store *runs.Store) *fakeLauncher {
	return &fakeLauncher{
		store:     store,
		launched:  make(chan string, 16),
		completed: make(chan string, 16),
		stopCalls: make(chan string, 16),
	}
}

func (f *fakeLauncher) Launch(_ context.Context, runID string) error {
	f.launches.Add(1)
	f.launched <- runID
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-time.After(launchGateTimeout):
		}
	}
	if f.launchErr != nil {
		return f.launchErr
	}
	if run, ok := f.store.Get(runID); ok && run.Status == runs.StatusPending {
		_ = f.store.SetStatus(runID, runs.StatusRunning)
	}
	f.completed <- runID
	return nil
}

func (f *fakeLauncher) Stop(_ context.Context, runID string) error {
	f.stops.Add(1)
	f.stopCalls <- runID
	if f.stopErr != nil {
		return f.stopErr
	}
	if f.onStop != nil {
		f.onStop(runID)
		return nil
	}
	f.finalize(runID)
	return nil
}

// finalize mirrors the engine completion path for an explicitly stopped run.
func (f *fakeLauncher) finalize(runID string) {
	run, ok := f.store.Get(runID)
	if !ok || isTerminal(run.Status) {
		return
	}
	if run.Status == runs.StatusPending {
		_ = f.store.SetStatus(runID, runs.StatusRunning)
	}
	_ = f.store.SetStatus(runID, runs.StatusStopped)
}

// lockedBuffer is a mutex-guarded log buffer: the async launch goroutine
// writes through slog while tests read assertions (race-detector clean).
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newSrv(t *testing.T, token string) (http.Handler, *runs.Store, *lockedBuffer) {
	t.Helper()
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	return newSrvWith(token, store, newFakeLauncher(store), logBuf), store, logBuf
}

// newSrvLaunch is newSrv with the fake launcher exposed for launch/stop
// wiring assertions.
func newSrvLaunch(t *testing.T, token string) (http.Handler, *runs.Store, *fakeLauncher, *lockedBuffer) {
	t.Helper()
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	launcher := newFakeLauncher(store)
	return newSrvWith(token, store, launcher, logBuf), store, launcher, logBuf
}

func newSrvWith(token string, store *runs.Store, launcher RunLauncher, logBuf *lockedBuffer) http.Handler {
	return NewHandler(Deps{
		Token:    token,
		Store:    store,
		Launcher: launcher,
		Logger:   slog.New(slog.NewTextHandler(logBuf, nil)),
	})
}

// waitLaunch waits for the async launch to finish promoting the run.
func waitLaunch(t *testing.T, f *fakeLauncher) string {
	t.Helper()
	select {
	case id := <-f.completed:
		return id
	case <-time.After(2 * time.Second):
		t.Fatal("async launch did not complete")
		return ""
	}
}

// waitFor polls cond until it holds or the deadline expires.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not reached in time: %s", what)
}

type option func(*http.Request)

func setAuth(header string) option {
	return func(r *http.Request) {
		if header == "" {
			r.Header.Del("Authorization")
			return
		}
		r.Header.Set("Authorization", header)
	}
}

func setHeader(name, value string) option {
	return func(r *http.Request) { r.Header.Set(name, value) }
}

func call(t *testing.T, h http.Handler, method, path, body string, opts ...option) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testToken)
	for _, opt := range opts {
		opt(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// jsonBody decodes a JSON API response and asserts the literal version: 1 envelope.
func jsonBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.Bytes(), err)
	}
	if decoded["version"] != float64(1) {
		t.Errorf("version = %v, want literal 1", decoded["version"])
	}
	return decoded
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.Bytes())
	}
	decoded := jsonBody(t, rec)
	if decoded["code"] != code {
		t.Errorf("code = %v, want %s", decoded["code"], code)
	}
	if message, _ := decoded["message"].(string); message == "" {
		t.Errorf("message = %q, want nonblank", message)
	}
}

func startRun(t *testing.T, h http.Handler, opts ...option) string {
	t.Helper()
	rec := call(t, h, http.MethodPost, "/api/runs", validStart, opts...)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("start status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
	id, _ := jsonBody(t, rec)["runId"].(string)
	if id == "" {
		t.Fatal("runId = empty, want nonblank")
	}
	return id
}

func TestHealthzPublicAndUnversioned(t *testing.T) {
	h, _, _ := newSrv(t, testToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Errorf("body = %q, want {\"status\":\"ok\"}", got)
	}
	if strings.Contains(rec.Body.String(), "version") {
		t.Errorf("healthz must stay unversioned, body %q", rec.Body.String())
	}
}

func TestBearerAuth(t *testing.T) {
	h, _, _ := newSrv(t, testToken)
	tests := []struct {
		name, auth string
		wantStatus int
		wantCode   string
	}{
		{"missing header", "", http.StatusUnauthorized, "unauthorized"},
		{"wrong scheme", "Basic " + testToken, http.StatusUnauthorized, "unauthorized"},
		{"wrong token", "Bearer not-the-token", http.StatusUnauthorized, "unauthorized"},
		{"empty bearer value", "Bearer ", http.StatusUnauthorized, "unauthorized"},
		{"valid bearer", "Bearer " + testToken, http.StatusNotFound, "run-not-found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := call(t, h, http.MethodGet, "/api/runs/run-none", "", setAuth(tt.auth))
			wantError(t, rec, tt.wantStatus, tt.wantCode)
		})
	}
}

func TestEmptyServiceTokenFailsClosed(t *testing.T) {
	h, _, _ := newSrv(t, "")
	for _, auth := range []string{"", "Bearer ", "Bearer " + testToken} {
		rec := call(t, h, http.MethodGet, "/api/runs/run-none", "", setAuth(auth))
		wantError(t, rec, http.StatusUnauthorized, "unauthorized")
	}
	rec := call(t, h, http.MethodGet, "/healthz", "", setAuth(""))
	if rec.Code != http.StatusOK {
		t.Errorf("healthz status = %d, want 200 even with empty token", rec.Code)
	}
}

func TestStartRunAccepted(t *testing.T) {
	h, store, fake, _ := newSrvLaunch(t, testToken)
	id := startRun(t, h)
	if !strings.HasPrefix(id, "run-") {
		t.Errorf("runId = %q, want run- prefix", id)
	}
	waitLaunch(t, fake)
	run, ok := store.Get(id)
	if !ok {
		t.Fatal("run not stored")
	}
	if run.Status != runs.StatusRunning {
		t.Errorf("status = %s, want running (promotion comes from the async launch)", run.Status)
	}
}

// TestStartRunLaunchesAsynchronously pins the K6F2-05 202 semantics: the
// response is answered while Launch is still blocked, so a synchronous
// implementation fails deterministically (its gate times out, the launch
// completes, and the post-response check finds it done).
func TestStartRunLaunchesAsynchronously(t *testing.T) {
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	fake := newFakeLauncher(store)
	fake.gate = make(chan struct{})
	h := newSrvWith(testToken, store, fake, logBuf)

	rec := call(t, h, http.MethodPost, "/api/runs", validStart)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
	id, _ := jsonBody(t, rec)["runId"].(string)
	select {
	case <-fake.completed:
		t.Fatal("launch completed before the 202 was answered; startRun must launch asynchronously")
	default:
	}
	close(fake.gate)
	if got := waitLaunch(t, fake); got != id {
		t.Errorf("launched runId = %q, want %q", got, id)
	}
	if n := fake.launches.Load(); n != 1 {
		t.Errorf("Launch calls = %d, want exactly 1", n)
	}
}

// TestStartRunLaunchErrorIsLoggedAfter202 documents that a Launch failure
// after the 202 is observed only as a log line here; terminalizing the run is
// the engine's own failure path (engine.failLaunch), not the handler's.
func TestStartRunLaunchErrorIsLoggedAfter202(t *testing.T) {
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	fake := newFakeLauncher(store)
	fake.launchErr = errors.New("create failed")
	h := newSrvWith(testToken, store, fake, logBuf)

	id := startRun(t, h)
	select {
	case <-fake.launched:
	case <-time.After(2 * time.Second):
		t.Fatal("Launch was never invoked")
	}
	waitFor(t, "launch error logged", func() bool {
		return strings.Contains(logBuf.String(), "async launch failed")
	})
	run, ok := store.Get(id)
	if !ok {
		t.Fatal("run not stored")
	}
	if isTerminal(run.Status) {
		t.Errorf("status = %s; the handler must not terminalize a launch error the engine owns", run.Status)
	}
}

func TestStartIdempotency(t *testing.T) {
	t.Run("identical key and payload replays 200 with same runId", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		first := startRun(t, h, setHeader("Idempotency-Key", "key-1"))
		rec := call(t, h, http.MethodPost, "/api/runs", validStart, setHeader("Idempotency-Key", "key-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("replay status = %d, want 200 (body %s)", rec.Code, rec.Body.Bytes())
		}
		if got := jsonBody(t, rec)["runId"]; got != first {
			t.Errorf("runId = %v, want %s", got, first)
		}
		if stored := store.List(); len(stored) != 1 {
			t.Errorf("stored runs = %d, want 1", len(stored))
		}
		waitLaunch(t, fake)
		if n := fake.launches.Load(); n != 1 {
			t.Errorf("Launch calls = %d, want 1 (a 200 replay must not relaunch)", n)
		}
	})
	t.Run("same key different payload creates a new run", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
		first := startRun(t, h, setHeader("Idempotency-Key", "key-1"))
		other := strings.Replace(validStart, `"vus":10`, `"vus":11`, 1)
		rec := call(t, h, http.MethodPost, "/api/runs", other, setHeader("Idempotency-Key", "key-1"))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", rec.Code)
		}
		if got := jsonBody(t, rec)["runId"]; got == first {
			t.Errorf("runId = %v, want a new id for a different payload", got)
		}
		if stored := store.List(); len(stored) != 2 {
			t.Errorf("stored runs = %d, want 2", len(stored))
		}
	})
	t.Run("absent key always creates", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
		a, b := startRun(t, h), startRun(t, h)
		if a == b {
			t.Errorf("runIds = %q twice, want distinct runs without a key", a)
		}
		if stored := store.List(); len(stored) != 2 {
			t.Errorf("stored runs = %d, want 2", len(stored))
		}
	})
}

func TestStartRejectsInvalidBody(t *testing.T) {
	h, store, _ := newSrv(t, testToken)
	tests := []struct{ name, body string }{
		{"empty body", ""},
		{"not json", "{oops"},
		{"trailing content", validStart + `{"x":1}`},
		{"missing version", strings.Replace(validStart, `"version":1,`, "", 1)},
		{"version string", strings.Replace(validStart, `"version":1`, `"version":"1"`, 1)},
		{"version two", strings.Replace(validStart, `"version":1`, `"version":2`, 1)},
		{"missing script", strings.Replace(validStart, scriptJSON+",", "", 1)},
		{"blank script", strings.Replace(validStart, scriptJSON, `"script":"  "`, 1)},
		{"script wrong type", strings.Replace(validStart, scriptJSON, `"script":42`, 1)},
		{"vus zero", strings.Replace(validStart, `"vus":10`, `"vus":0`, 1)},
		{"vus fractional", strings.Replace(validStart, `"vus":10`, `"vus":1.5`, 1)},
		{"vus unsafe integer", strings.Replace(validStart, `"vus":10`, `"vus":9007199254740992`, 1)},
		{"missing durationMs", strings.Replace(validStart, `"durationMs":5000,`, "", 1)},
		{"cpuMillis zero", strings.Replace(validStart, `"cpuMillis":500`, `"cpuMillis":0`, 1)},
		{"memoryMiB zero", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":0`, 1)},
		{"unknown field", strings.Replace(validStart, `"version":1,`, `"version":1,"extra":true,`, 1)},
		{"metadata field", strings.Replace(validStart, `"version":1,`, `"version":1,"metadata":{"a":1},`, 1)},
		{"attachment blank id", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"attachments":[{"id":" "}]`, 1)},
		{"attachment unknown field", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"attachments":[{"id":"a","x":1}]`, 1)},
		{"attachment wrong type", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"attachments":"a"`, 1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := call(t, h, http.MethodPost, "/api/runs", tt.body)
			wantError(t, rec, http.StatusBadRequest, "invalid-request")
		})
	}
	if stored := store.List(); len(stored) != 0 {
		t.Errorf("stored runs = %d, want 0 (invalid bodies must not create)", len(stored))
	}
}

func TestStopRun(t *testing.T) {
	t.Run("known non-terminal run stops with 202", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
		}
		if got := jsonBody(t, rec)["runId"]; got != id {
			t.Errorf("runId = %v, want %s", got, id)
		}
		run, _ := store.Get(id)
		if run.Status != runs.StatusStopped {
			t.Errorf("status = %s, want stopped", run.Status)
		}
	})
	t.Run("unknown run 404", func(t *testing.T) {
		h, _, _ := newSrv(t, testToken)
		rec := call(t, h, http.MethodPost, "/api/runs/run-none/stop", "")
		wantError(t, rec, http.StatusNotFound, "run-not-found")
	})
	t.Run("repeated stop is idempotent 202", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
		first := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		second := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if second.Code != http.StatusAccepted {
			t.Fatalf("second stop status = %d, want 202 (body %s)", second.Code, second.Body.Bytes())
		}
		if got, want := jsonBody(t, second)["runId"], jsonBody(t, first)["runId"]; got != want {
			t.Errorf("runId = %v, want %v", got, want)
		}
		run, _ := store.Get(id)
		if run.Status != runs.StatusStopped {
			t.Errorf("status = %s, want stopped", run.Status)
		}
	})
	t.Run("terminal finished run stays finished", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake)
		if err := store.SetStatus(id, runs.StatusFinished); err != nil {
			t.Fatalf("SetStatus finished: %v", err)
		}
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want idempotent 202", rec.Code)
		}
		run, _ := store.Get(id)
		if run.Status != runs.StatusFinished {
			t.Errorf("status = %s, want finished (terminal state must not move)", run.Status)
		}
	})
	t.Run("launcher stop is requested for non-terminal runs", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake) // run is running: the engine owns finalization
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
		}
		if n := fake.stops.Load(); n != 1 {
			t.Errorf("Stop calls = %d, want 1", n)
		}
		select {
		case stoppedID := <-fake.stopCalls:
			if stoppedID != id {
				t.Errorf("stopped runId = %q, want %q", stoppedID, id)
			}
		default:
			t.Fatal("launcher never saw the stop request")
		}
		run, _ := store.Get(id)
		if run.Status != runs.StatusStopped {
			t.Errorf("status = %s, want stopped (launcher completion contract)", run.Status)
		}
	})
	t.Run("terminal run never reaches the launcher", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake)
		if err := store.SetStatus(id, runs.StatusFinished); err != nil {
			t.Fatalf("SetStatus finished: %v", err)
		}
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want idempotent 202", rec.Code)
		}
		if n := fake.stops.Load(); n != 0 {
			t.Errorf("Stop calls = %d, want 0 for a terminal run", n)
		}
	})
	t.Run("launcher stop failure keeps 202 and the handler terminalizes a pending run", func(t *testing.T) {
		h, store, fake, logBuf := newSrvLaunch(t, testToken)
		fake.stopErr = errors.New("container stop failed")
		// A run the engine never launched (still pending, no launch goroutine
		// in flight): the handler owns the terminal transition.
		run, err := store.Create(runs.Run{Script: "export default function () {}", VUs: 1, DurationMs: 1000, CPUMillis: 100, MemoryMiB: 64})
		if err != nil {
			t.Fatalf("store.Create: %v", err)
		}
		id := run.ID
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202 despite launcher error (body %s)", rec.Code, rec.Body.Bytes())
		}
		run, _ = store.Get(id)
		if run.Status != runs.StatusStopped {
			t.Errorf("status = %s, want stopped", run.Status)
		}
		if !strings.Contains(logBuf.String(), "engine stop failed") {
			t.Errorf("launcher stop error not logged; logs = %s", logBuf.String())
		}
	})
	t.Run("engine-owned running run converges through the launcher", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		// The launcher acknowledges the stop but does not finalize yet, exactly
		// like an engine whose completion goroutine is still draining: the
		// handler must NOT steal the terminal transition (that would reject the
		// engine's final SetStatus and drop the stopped-run summary).
		fake.onStop = func(string) {}
		id := startRun(t, h)
		waitLaunch(t, fake)
		rec := call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
		}
		if n := fake.stops.Load(); n != 1 {
			t.Errorf("Stop calls = %d, want 1", n)
		}
		run, _ := store.Get(id)
		if run.Status != runs.StatusRunning {
			t.Errorf("status = %s, want running until the engine completion path finalizes it", run.Status)
		}
	})
}

func TestGetRunState(t *testing.T) {
	h, _, fake, _ := newSrvLaunch(t, testToken)
	id := startRun(t, h)
	waitLaunch(t, fake)
	rec := call(t, h, http.MethodGet, "/api/runs/"+id, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.Bytes())
	}
	got := jsonBody(t, rec)
	if got["runId"] != id || got["status"] != "running" {
		t.Errorf("state = %v, want runId %s with status running", got, id)
	}
	rec = call(t, h, http.MethodGet, "/api/runs/run-none", "")
	wantError(t, rec, http.StatusNotFound, "run-not-found")
}

func TestRunSummary(t *testing.T) {
	t.Run("unknown run 404", func(t *testing.T) {
		h, _, _ := newSrv(t, testToken)
		wantError(t, call(t, h, http.MethodGet, "/api/runs/run-none/summary", ""), http.StatusNotFound, "run-not-found")
	})
	t.Run("nonterminal run 409", func(t *testing.T) {
		h, _, _ := newSrv(t, testToken)
		id := startRun(t, h)
		wantError(t, call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", ""), http.StatusConflict, "summary-not-terminal")
	})
	t.Run("terminal without summary 409", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake)
		if err := store.SetStatus(id, runs.StatusFinished); err != nil {
			t.Fatalf("SetStatus finished: %v", err)
		}
		wantError(t, call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", ""), http.StatusConflict, "summary-not-terminal")
	})
	t.Run("finished summary 200", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake)
		if err := store.SetStatus(id, runs.StatusFinished); err != nil {
			t.Fatalf("SetStatus finished: %v", err)
		}
		summary := &runs.Summary{
			Totals:           runs.Totals{Requests: 3, Errors: 1, FailedChecks: 0},
			LatencyMs:        runs.LatencyMs{Avg: 12.5, P90: 30, P95: 40, P99: 60},
			ThresholdsPassed: true,
		}
		if err := store.SetSummary(id, summary); err != nil {
			t.Fatalf("SetSummary: %v", err)
		}
		rec := call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.Bytes())
		}
		got := jsonBody(t, rec)
		if got["runId"] != id || got["status"] != "finished" || got["thresholdsPassed"] != true {
			t.Errorf("summary = %v, want finished run with thresholdsPassed true", got)
		}
		totals, _ := got["totals"].(map[string]any)
		if totals["requests"] != float64(3) || totals["errors"] != float64(1) || totals["failedChecks"] != float64(0) {
			t.Errorf("totals = %v, want requests 3 errors 1 failedChecks 0", totals)
		}
		latency, _ := got["latency"].(map[string]any)
		if latency["avgMs"] != 12.5 || latency["p90Ms"] != float64(30) || latency["p95Ms"] != float64(40) || latency["p99Ms"] != float64(60) {
			t.Errorf("latency = %v, want avg 12.5 p90 30 p95 40 p99 60", latency)
		}
	})
	t.Run("stopped summary omits thresholdsPassed", func(t *testing.T) {
		h, store, fake, _ := newSrvLaunch(t, testToken)
		id := startRun(t, h)
		waitLaunch(t, fake)
		if err := store.SetStatus(id, runs.StatusStopped); err != nil {
			t.Fatalf("SetStatus stopped: %v", err)
		}
		summary := &runs.Summary{
			Totals:           runs.Totals{Requests: 2},
			LatencyMs:        runs.LatencyMs{Avg: 7},
			ThresholdsPassed: true,
		}
		if err := store.SetSummary(id, summary); err != nil {
			t.Fatalf("SetSummary: %v", err)
		}
		rec := call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.Bytes())
		}
		got := jsonBody(t, rec)
		if got["status"] != "stopped" {
			t.Errorf("status = %v, want stopped", got["status"])
		}
		if _, present := got["thresholdsPassed"]; present {
			t.Errorf("thresholdsPassed = %v, want absent unless finished", got["thresholdsPassed"])
		}
	})
}

func TestLogsNeverContainTokenOrScript(t *testing.T) {
	h, _, logBuf := newSrv(t, testToken)
	call(t, h, http.MethodGet, "/api/runs/run-none", "", setAuth(""))                                   // 401 warning
	id := startRun(t, h)                                                                                // accepted info
	call(t, h, http.MethodPost, "/api/runs", `{"version":1}`)                                           // invalid warning
	call(t, h, http.MethodPost, "/api/runs", strings.Replace(validStart, scriptJSON, `"script":42`, 1)) // type error warning
	call(t, h, http.MethodPost, "/api/runs/"+id+"/stop", "")                                            // stopped info
	call(t, h, http.MethodGet, "/api/runs/"+id, "")                                                     // state read
	call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", "")                                          // 409 path
	logs := logBuf.String()
	if logs == "" {
		t.Fatal("logs = empty, want structured output")
	}
	if strings.Contains(logs, testToken) {
		t.Errorf("service token leaked into logs: %s", logs)
	}
	if strings.Contains(logs, testScript) {
		t.Errorf("script body leaked into logs: %s", logs)
	}
}
