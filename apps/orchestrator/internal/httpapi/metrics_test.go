package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
)

// fakeFrameSource stands in for the live metrics hub: it returns the frame it
// was given and counts lookups, making the auth-before-lookup order provable.
type fakeFrameSource struct {
	frames  map[string]metrics.MetricsFrame
	lookups int
}

func (f *fakeFrameSource) LastFrame(runID string) (metrics.MetricsFrame, bool) {
	f.lookups++
	frame, ok := f.frames[runID]
	return frame, ok
}

func sampleFrame(runID string) metrics.MetricsFrame {
	reqPerSec, avg, p90, p95, p99, failure := 4.5, 12.5, 10.0, 21.5, 33.25, 0.125
	return metrics.MetricsFrame{
		Version:             1,
		Type:                "metrics",
		RunID:               runID,
		Seq:                 7,
		Window:              metrics.Window{StartMs: 7000, DurationMs: 1000},
		ReqPerSec:           &reqPerSec,
		LatencyMs:           metrics.LatencyMs{Avg: &avg, P90: &p90, P95: &p95, P99: &p99},
		HTTPFailureFraction: &failure,
		ActiveVUs:           5,
		FailedChecks:        2,
	}
}

func getRunMetrics(t *testing.T, handler http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// The polling fallback needs the same frame the WS `tick` carries: the body
// must be the frame's contract encoding field for field.
func TestRunMetricsServesLatestFrameUnchanged(t *testing.T) {
	frame := sampleFrame("run-1")
	source := &fakeFrameSource{frames: map[string]metrics.MetricsFrame{"run-1": frame}}
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken, Frames: source})

	response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", testToken)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	want, err := frame.EncodeJSON()
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}
	if got := response.Body.String(); got != string(want) {
		t.Errorf("body =\n %s\nwant\n %s", got, want)
	}
	var decoded metrics.MetricsFrame
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("body is not a metrics frame: %v", err)
	}
	if decoded.RunID != "run-1" || decoded.Seq != 7 || decoded.ActiveVUs != 5 || decoded.ReqPerSec == nil || *decoded.ReqPerSec != 4.5 {
		t.Errorf("decoded frame = %+v, want run-1 seq 7 with values", decoded)
	}
	if source.lookups != 1 {
		t.Errorf("snapshot lookups = %d, want 1", source.lookups)
	}
}

func TestRunMetricsIsNoStore(t *testing.T) {
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken, Frames: &fakeFrameSource{frames: map[string]metrics.MetricsFrame{}}})
	response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", testToken)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("404 Cache-Control = %q, want no-store", got)
	}
}

// No window yet (or an unknown run) is a 404 in the contract error envelope; the
// panel treats it as "no snapshot" and keeps polling status.
func TestRunMetricsWithoutSnapshotIs404(t *testing.T) {
	source := &fakeFrameSource{frames: map[string]metrics.MetricsFrame{}}
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken, Frames: source})

	response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", testToken)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", response.Code, response.Body.String())
	}
	var body errorBody
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body: %v", err)
	}
	if body.Version != contractVersion || body.Code != codeRunNotFound || body.Message != msgRunNotFound {
		t.Errorf("error body = %+v, want %s/%s", body, codeRunNotFound, msgRunNotFound)
	}
}

// The snapshot dependency is optional: no source wired means 404, never a panic.
func TestRunMetricsWithoutFrameSourceIs404(t *testing.T) {
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken})
	response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", testToken)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", response.Code, response.Body.String())
	}
}

// /api/* keeps its static Bearer gate, and auth runs before the snapshot lookup.
func TestRunMetricsRequiresBearerAuth(t *testing.T) {
	source := &fakeFrameSource{frames: map[string]metrics.MetricsFrame{"run-1": sampleFrame("run-1")}}
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken, Frames: source})

	for _, tc := range []struct{ name, token string }{
		{"missing", ""},
		{"wrong", "not-the-token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", tc.token)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.Code)
			}
			if body := response.Body.String(); !strings.Contains(body, codeUnauthorized) {
				t.Errorf("401 body = %s, want the %s catalog code", body, codeUnauthorized)
			}
			if source.lookups != 0 {
				t.Errorf("snapshot read before auth (%d lookups)", source.lookups)
			}
		})
	}

	if response := getRunMetrics(t, handler, "/api/runs/run-1/metrics", testToken); response.Code != http.StatusOK {
		t.Fatalf("authorized status = %d, want 200", response.Code)
	}
}

// GET only, like every other /api/runs/{runId}/... route.
func TestRunMetricsRejectsNonGet(t *testing.T) {
	handler := NewHandler(Deps{Store: runs.NewStore(), Token: testToken, Frames: &fakeFrameSource{}})
	request := httptest.NewRequest(http.MethodPost, "/api/runs/run-1/metrics", nil)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405 (body %s)", response.Code, response.Body.String())
	}
}
