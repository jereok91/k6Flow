package config

import (
	"os"
	"strings"
	"testing"
)

// configEnv lists every environment variable Load reads.
var configEnv = []string{"ORCHESTRATOR_ADDR", "K6_IMAGE", "MAX_CONCURRENT_RUNS", "MAX_VUS_PER_RUN", "RUN_TIMEOUT_MS", "SERVICE_TOKEN", "LOG_LEVEL"}

// clearEnv makes every config variable absent so defaults apply.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, key := range configEnv {
		if old, existed := os.LookupEnv(key); existed {
			os.Unsetenv(key)
			t.Cleanup(func() { _ = os.Setenv(key, old) })
		}
	}
}

// TestLoadDefaultsWhenAbsent checks every documented default.
func TestLoadDefaultsWhenAbsent(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != ":8080" || cfg.K6Image != "grafana/k6" || cfg.MaxConcurrentRuns != 3 ||
		cfg.MaxVUsPerRun != 500 || cfg.RunTimeoutMS != 3600000 || cfg.LogLevel != "info" || cfg.ServiceToken != "" {
		t.Errorf("defaults = %+v", cfg)
	}
}

// TestLoadAppliesOverrides checks explicit environment values win over defaults.
func TestLoadAppliesOverrides(t *testing.T) {
	clearEnv(t)
	for key, value := range map[string]string{
		"ORCHESTRATOR_ADDR": ":9090", "K6_IMAGE": "grafana/k6:0.57", "SERVICE_TOKEN": "static-token",
		"MAX_CONCURRENT_RUNS": "5", "MAX_VUS_PER_RUN": "25", "RUN_TIMEOUT_MS": "60000", "LOG_LEVEL": "debug",
	} {
		t.Setenv(key, value)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != ":9090" || cfg.K6Image != "grafana/k6:0.57" || cfg.ServiceToken != "static-token" ||
		cfg.MaxConcurrentRuns != 5 || cfg.MaxVUsPerRun != 25 || cfg.RunTimeoutMS != 60000 || cfg.LogLevel != "debug" {
		t.Errorf("overrides = %+v", cfg)
	}
}

// TestLoadRejectsInvalidValuesWithoutCoercion checks the Phase 1 no-coercion
// policy: explicit invalid input is a descriptive error naming the variable.
func TestLoadRejectsInvalidValuesWithoutCoercion(t *testing.T) {
	tests := []struct{ name, key, value string }{
		{"non-numeric concurrency", "MAX_CONCURRENT_RUNS", "three"},
		{"zero concurrency", "MAX_CONCURRENT_RUNS", "0"},
		{"negative vus", "MAX_VUS_PER_RUN", "-1"},
		{"non-numeric timeout", "RUN_TIMEOUT_MS", "1h"},
		{"negative timeout", "RUN_TIMEOUT_MS", "-5"},
		{"unknown log level", "LOG_LEVEL", "trace"},
		{"empty log level", "LOG_LEVEL", ""},
		{"empty address", "ORCHESTRATOR_ADDR", ""},
		{"empty image", "K6_IMAGE", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearEnv(t)
			t.Setenv(tt.key, tt.value)
			_, err := Load()
			if err == nil {
				t.Fatalf("Load accepted %s=%q", tt.key, tt.value)
			}
			if !strings.Contains(err.Error(), tt.key) {
				t.Errorf("error %q does not name %s", err, tt.key)
			}
		})
	}
}

// TestLoadFailClosedEmptyServiceTokenRejectsAllRequests documents the
// fail-closed contract: an empty SERVICE_TOKEN is a valid configuration and
// the auth middleware (K6F2-02) must then reject every /api/* request.
func TestLoadFailClosedEmptyServiceTokenRejectsAllRequests(t *testing.T) {
	clearEnv(t)
	t.Setenv("SERVICE_TOKEN", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ServiceToken != "" {
		t.Errorf("ServiceToken = %q, want empty so auth fails closed", cfg.ServiceToken)
	}
}
