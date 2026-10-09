package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"k6flow/apps/orchestrator/internal/runs"
)

// k6flow-variables V-T3: optional secret env on run start.

const envSecret = "sup3r-s3cret-v4lue-7c1e"

// withEnv returns validStart with an `env` object appended.
func withEnv(t *testing.T, env map[string]string) string {
	t.Helper()
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal env: %v", err)
	}
	return strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"env":`+string(raw), 1)
}

// envRecorder wraps the fake launcher and records the env each launch got.
type envRecorder struct {
	*fakeLauncher
	mu   sync.Mutex
	envs map[string]map[string]string
}

func (e *envRecorder) LaunchWithEnv(ctx context.Context, runID string, env map[string]string) error {
	e.mu.Lock()
	copied := make(map[string]string, len(env))
	for k, v := range env {
		copied[k] = v
	}
	e.envs[runID] = copied
	e.mu.Unlock()
	return e.fakeLauncher.Launch(ctx, runID)
}

func (e *envRecorder) envFor(runID string) (map[string]string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	env, ok := e.envs[runID]
	return env, ok
}

func newSrvEnv(t *testing.T) (http.Handler, *runs.Store, *envRecorder, *lockedBuffer) {
	t.Helper()
	store, logBuf := runs.NewStore(), &lockedBuffer{}
	rec := &envRecorder{fakeLauncher: newFakeLauncher(store), envs: map[string]map[string]string{}}
	return newSrvWith(testToken, store, rec, logBuf), store, rec, logBuf
}

func TestStartRunForwardsEnvToLauncher(t *testing.T) {
	h, _, launcher, _ := newSrvEnv(t)
	env := map[string]string{"K6FLOW_VAR_TOKEN": envSecret, "K6FLOW_VAR_API_KEY": "k"}
	rec := call(t, h, http.MethodPost, "/api/runs", withEnv(t, env))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
	id := jsonBody(t, rec)["runId"].(string)
	waitLaunch(t, launcher.fakeLauncher)
	got, ok := launcher.envFor(id)
	if !ok {
		t.Fatal("LaunchWithEnv was not called")
	}
	if len(got) != 2 || got["K6FLOW_VAR_TOKEN"] != envSecret || got["K6FLOW_VAR_API_KEY"] != "k" {
		t.Errorf("env = %v, want the request env", got)
	}
}

func TestStartRunWithoutEnvUsesPlainLaunch(t *testing.T) {
	h, _, launcher, _ := newSrvEnv(t)
	id := startRun(t, h)
	waitLaunch(t, launcher.fakeLauncher)
	if env, ok := launcher.envFor(id); ok && len(env) != 0 {
		t.Errorf("env = %v, want none for a body without env", env)
	}
}

func TestStartRunRejectsInvalidEnv(t *testing.T) {
	h, store, _, logs := newSrvEnv(t)
	many := map[string]string{}
	for i := 0; i < 101; i++ {
		many[fmt.Sprintf("K6FLOW_VAR_V%d", i)] = "x"
	}
	bigTotal := map[string]string{}
	for i := 0; i < 9; i++ {
		bigTotal[fmt.Sprintf("K6FLOW_VAR_B%d", i)] = strings.Repeat("a", 8*1024)
	}
	tests := []struct {
		name string
		body string
	}{
		{"reserved script key", withEnv(t, map[string]string{"K6FLOW_SCRIPT": envSecret})},
		{"missing prefix", withEnv(t, map[string]string{"TOKEN": envSecret})},
		{"lowercase", withEnv(t, map[string]string{"K6FLOW_VAR_token": envSecret})},
		{"empty suffix", withEnv(t, map[string]string{"K6FLOW_VAR_": envSecret})},
		{"bad char", withEnv(t, map[string]string{"K6FLOW_VAR_A-B": envSecret})},
		{"suffix too long", withEnv(t, map[string]string{"K6FLOW_VAR_" + strings.Repeat("A", 81): envSecret})},
		{"path override", withEnv(t, map[string]string{"PATH": envSecret})},
		{"too many entries", withEnv(t, many)},
		{"value too long", withEnv(t, map[string]string{"K6FLOW_VAR_BIG": strings.Repeat("a", 8*1024+1)})},
		{"total too large", withEnv(t, bigTotal)},
		{"value wrong type", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"env":{"K6FLOW_VAR_X":1}`, 1)},
		{"env not object", strings.Replace(validStart, `"memoryMiB":256`, `"memoryMiB":256,"env":"x"`, 1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := call(t, h, http.MethodPost, "/api/runs", tt.body)
			wantError(t, rec, http.StatusBadRequest, "invalid-request")
		})
	}
	if stored := store.List(); len(stored) != 0 {
		t.Errorf("stored runs = %d, want 0", len(stored))
	}
	if strings.Contains(logs.String(), envSecret) {
		t.Errorf("logs leak an env value: %s", logs.String())
	}
}

func TestStartRunEnvBoundariesAccepted(t *testing.T) {
	h, _, launcher, _ := newSrvEnv(t)
	env := map[string]string{
		"K6FLOW_VAR_" + strings.Repeat("A", 80): strings.Repeat("v", 8*1024),
		"K6FLOW_VAR_EMPTY_OK":                   "",
	}
	rec := call(t, h, http.MethodPost, "/api/runs", withEnv(t, env))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
	waitLaunch(t, launcher.fakeLauncher)
	exactly := map[string]string{}
	for i := 0; i < 100; i++ {
		exactly[fmt.Sprintf("K6FLOW_VAR_V%d", i)] = "x"
	}
	if rec := call(t, h, http.MethodPost, "/api/runs", withEnv(t, exactly)); rec.Code != http.StatusAccepted {
		t.Fatalf("100 entries status = %d, want 202 (body %s)", rec.Code, rec.Body.Bytes())
	}
}

func TestEnvValuesNeverStoredReturnedOrLogged(t *testing.T) {
	h, store, launcher, logs := newSrvEnv(t)
	rec := call(t, h, http.MethodPost, "/api/runs",
		withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": envSecret}),
		setHeader("Idempotency-Key", "key-env"))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.Bytes())
	}
	id := jsonBody(t, rec)["runId"].(string)
	waitLaunch(t, launcher.fakeLauncher)

	run, ok := store.Get(id)
	if !ok {
		t.Fatal("run missing")
	}
	if dump := fmt.Sprintf("%+v", run); strings.Contains(dump, envSecret) {
		t.Errorf("run record holds the env value: %s", dump)
	}
	for _, path := range []string{"/api/runs/" + id, "/api/runs", "/api/runs/active"} {
		got := call(t, h, http.MethodGet, path, "")
		if strings.Contains(got.Body.String(), envSecret) || strings.Contains(got.Body.String(), "K6FLOW_VAR_TOKEN") {
			t.Errorf("GET %s leaks env: %s", path, got.Body.String())
		}
	}
	// A rejected start must not log the value either.
	call(t, h, http.MethodPost, "/api/runs", withEnv(t, map[string]string{"bad key": envSecret}))
	if strings.Contains(logs.String(), envSecret) {
		t.Errorf("logs leak an env value: %s", logs.String())
	}
}

func TestEnvAffectsIdempotencyHash(t *testing.T) {
	h, store, launcher, _ := newSrvEnv(t)
	key := setHeader("Idempotency-Key", "key-env")
	first := call(t, h, http.MethodPost, "/api/runs", withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": "a"}), key)
	if first.Code != http.StatusAccepted {
		t.Fatalf("status = %d", first.Code)
	}
	firstID := jsonBody(t, first)["runId"]
	waitLaunch(t, launcher.fakeLauncher)

	replay := call(t, h, http.MethodPost, "/api/runs", withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": "a"}), key)
	if replay.Code != http.StatusOK || jsonBody(t, replay)["runId"] != firstID {
		t.Errorf("identical env replay = %d %s, want 200 with the same runId", replay.Code, replay.Body.Bytes())
	}
	other := call(t, h, http.MethodPost, "/api/runs", withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": "b"}), key)
	if other.Code != http.StatusAccepted || jsonBody(t, other)["runId"] == firstID {
		t.Errorf("different env = %d %s, want 202 with a new runId", other.Code, other.Body.Bytes())
	}
	if n := len(store.List()); n != 2 {
		t.Errorf("stored runs = %d, want 2", n)
	}
}

func TestStartRunEnvRequiresEnvCapableLauncher(t *testing.T) {
	// The plain fake launcher lacks LaunchWithEnv: env must not be silently dropped.
	h, store, _ := newSrv(t, testToken)
	rec := call(t, h, http.MethodPost, "/api/runs", withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": envSecret}))
	wantError(t, rec, http.StatusInternalServerError, "internal")
	if n := len(store.List()); n != 0 {
		t.Errorf("stored runs = %d, want 0", n)
	}
}

func TestPreflightAcceptsEnvWithoutEcho(t *testing.T) {
	h, _, _, _ := newSrvEnv(t)
	rec := call(t, h, http.MethodPost, "/api/runs/preflight", withEnv(t, map[string]string{"K6FLOW_VAR_TOKEN": envSecret}))
	if rec.Code != http.StatusOK || jsonBody(t, rec)["valid"] != true {
		t.Fatalf("preflight = %d %s, want valid", rec.Code, rec.Body.Bytes())
	}
	bad := call(t, h, http.MethodPost, "/api/runs/preflight", withEnv(t, map[string]string{"bad": envSecret}))
	if strings.Contains(bad.Body.String(), envSecret) {
		t.Errorf("preflight echoes env value: %s", bad.Body.String())
	}
}
