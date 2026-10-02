package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k6flow/apps/orchestrator/internal/runs"
	"k6flow/apps/orchestrator/internal/runtime"
)

const (
	testToken  = "s3cr3t-t0ken-9f3a2b"
	testScript = "import http from 'k6/http'; export default function () {}"
	scriptJSON = "\"script\":\"" + testScript + "\""
	validStart = `{"version":1,"script":"` + testScript + `","vus":10,"durationMs":5000,"cpuMillis":500,"memoryMiB":256}`
)

func newSrv(t *testing.T, token string) (http.Handler, *runs.Store, *bytes.Buffer) {
	t.Helper()
	store, logBuf := runs.NewStore(), &bytes.Buffer{}
	handler := NewHandler(Deps{
		Token:   token,
		Store:   store,
		Runtime: runtime.NewFakeRuntime(),
		Logger:  slog.New(slog.NewTextHandler(logBuf, nil)),
	})
	return handler, store, logBuf
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
	h, store, _ := newSrv(t, testToken)
	id := startRun(t, h)
	if !strings.HasPrefix(id, "run-") {
		t.Errorf("runId = %q, want run- prefix", id)
	}
	run, ok := store.Get(id)
	if !ok {
		t.Fatal("run not stored")
	}
	if run.Status != runs.StatusRunning {
		t.Errorf("status = %s, want running (immediate promotion; engine is K6F2-03)", run.Status)
	}
}

func TestStartIdempotency(t *testing.T) {
	t.Run("identical key and payload replays 200 with same runId", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
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
	t.Run("known running run stops with 202", func(t *testing.T) {
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
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
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
}

func TestGetRunState(t *testing.T) {
	h, _, _ := newSrv(t, testToken)
	id := startRun(t, h)
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
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
		if err := store.SetStatus(id, runs.StatusFinished); err != nil {
			t.Fatalf("SetStatus finished: %v", err)
		}
		wantError(t, call(t, h, http.MethodGet, "/api/runs/"+id+"/summary", ""), http.StatusConflict, "summary-not-terminal")
	})
	t.Run("finished summary 200", func(t *testing.T) {
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
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
		h, store, _ := newSrv(t, testToken)
		id := startRun(t, h)
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
