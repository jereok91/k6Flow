package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"k6flow/apps/orchestrator/internal/runs"
)

// testLimits are deliberately small so validStart (10 VUs, 500 mCPU,
// 256 MiB) sits below every ceiling.
var testLimits = RunLimits{MaxVUs: 500, MaxMemoryMiB: 4096, MaxCPUMillis: 4000}

func newSrvLimits(t *testing.T, limits RunLimits) (http.Handler, *runs.Store, *fakeLauncher) {
	t.Helper()
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	launcher := newFakeLauncher(store)
	h := NewHandler(Deps{
		Token:    testToken,
		Store:    store,
		Launcher: launcher,
		Logger:   slog.New(slog.NewTextHandler(logBuf, nil)),
		Limits:   limits,
	})
	return h, store, launcher
}

// limitCases covers each per-run ceiling with an over-limit body and the
// substrings its message must carry (requested value, limit, env variable).
var limitCases = []struct {
	name, body, code string
	wantMsg          []string
}{
	{
		"vus over limit",
		strings.Replace(validStart, `"vus":10`, `"vus":1900`, 1),
		"vus-limit-exceeded",
		[]string{"1900", "500", "MAX_VUS_PER_RUN"},
	},
	{
		"memory over limit",
		strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":8192`, 1),
		"memory-limit-exceeded",
		[]string{"8192", "4096", "MAX_MEMORY_MIB_PER_RUN"},
	},
	{
		"cpu over limit",
		strings.Replace(validStart, `"cpuMillis":500`, `"cpuMillis":4001`, 1),
		"cpu-limit-exceeded",
		[]string{"4001", "4000", "MAX_CPU_MILLIS_PER_RUN"},
	},
}

func TestStartRunRejectsOverLimit(t *testing.T) {
	for _, tt := range limitCases {
		t.Run(tt.name, func(t *testing.T) {
			h, store, fake := newSrvLimits(t, testLimits)
			rec := call(t, h, http.MethodPost, "/api/runs", tt.body, setHeader("Idempotency-Key", "k-"+tt.code))
			wantError(t, rec, http.StatusUnprocessableEntity, tt.code)
			message, _ := jsonBody(t, rec)["message"].(string)
			for _, want := range tt.wantMsg {
				if !strings.Contains(message, want) {
					t.Errorf("message %q does not contain %q", message, want)
				}
			}
			if stored := store.List(); len(stored) != 0 {
				t.Errorf("stored runs = %d, want 0 (rejected start must not create)", len(stored))
			}
			if n := fake.launches.Load(); n != 0 {
				t.Errorf("launches = %d, want 0 (rejected start must not launch)", n)
			}
			// A rejected keyed start leaves idempotency untouched: the same key
			// with a valid body still creates a fresh run.
			if id := startRun(t, h, setHeader("Idempotency-Key", "k-"+tt.code)); id == "" {
				t.Fatal("valid start after rejection returned no runId")
			}
		})
	}
}

func TestPreflightRejectsOverLimit(t *testing.T) {
	for _, tt := range limitCases {
		t.Run(tt.name, func(t *testing.T) {
			h, store, fake := newSrvLimits(t, testLimits)
			rec := call(t, h, http.MethodPost, "/api/runs/preflight", tt.body)
			wantError(t, rec, http.StatusUnprocessableEntity, tt.code)
			message, _ := jsonBody(t, rec)["message"].(string)
			for _, want := range tt.wantMsg {
				if !strings.Contains(message, want) {
					t.Errorf("message %q does not contain %q", message, want)
				}
			}
			if stored := store.List(); len(stored) != 0 {
				t.Errorf("stored runs = %d, want 0", len(stored))
			}
			if n := fake.launches.Load(); n != 0 {
				t.Errorf("launches = %d, want 0", n)
			}
		})
	}
}

// atLimitStart requests exactly every ceiling: limits are inclusive.
var atLimitStart = `{"version":1,"script":"` + testScript + `","vus":500,"durationMs":5000,"cpuMillis":4000,"memoryMiB":4096}`

func TestStartRunAtLimitAccepted(t *testing.T) {
	h, store, fake := newSrvLimits(t, testLimits)
	rec := call(t, h, http.MethodPost, "/api/runs", atLimitStart)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
	id, _ := jsonBody(t, rec)["runId"].(string)
	waitLaunch(t, fake)
	if _, ok := store.Get(id); !ok {
		t.Fatalf("run %q not stored", id)
	}
}

func TestPreflightAtLimitValid(t *testing.T) {
	h, _, _ := newSrvLimits(t, testLimits)
	rec := call(t, h, http.MethodPost, "/api/runs/preflight", atLimitStart)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.Bytes())
	}
	if valid, _ := jsonBody(t, rec)["valid"].(bool); !valid {
		t.Errorf("valid = false, want true (body %s)", rec.Body.Bytes())
	}
}

// TestLimitsCheckedAfterValidation keeps malformed bodies on the existing
// 400 invalid-request path even when they also exceed a ceiling.
func TestLimitsCheckedAfterValidation(t *testing.T) {
	h, _, _ := newSrvLimits(t, testLimits)
	body := strings.Replace(strings.Replace(validStart, `"vus":10`, `"vus":1900`, 1), `"version":1`, `"version":2`, 1)
	rec := call(t, h, http.MethodPost, "/api/runs", body)
	wantError(t, rec, http.StatusBadRequest, "invalid-request")
}
