package config

import (
	"os"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	// Clear env vars
	os.Unsetenv("RECORDER_PORT")
	os.Unsetenv("RECORDER_PROXY_PORT")
	os.Unsetenv("RECORDER_AUTH_TOKEN")
	os.Unsetenv("RECORDER_MAX_DURATION_SEC")
	os.Unsetenv("RECORDER_INACTIVITY_SEC")

	cfg := Load()

	if cfg.Port != 8081 {
		t.Errorf("Port = %d, want 8081", cfg.Port)
	}
	if cfg.ProxyPort != 8082 {
		t.Errorf("ProxyPort = %d, want 8082", cfg.ProxyPort)
	}
	if cfg.AuthToken != "" {
		t.Errorf("AuthToken = %q, want empty", cfg.AuthToken)
	}
	if cfg.MaxDurationSec != 3600 {
		t.Errorf("MaxDurationSec = %d, want 3600", cfg.MaxDurationSec)
	}
	if cfg.InactivitySec != 300 {
		t.Errorf("InactivitySec = %d, want 300", cfg.InactivitySec)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("RECORDER_PORT", "9000")
	os.Setenv("RECORDER_PROXY_PORT", "9001")
	os.Setenv("RECORDER_AUTH_TOKEN", "secret-token")
	os.Setenv("RECORDER_MAX_DURATION_SEC", "7200")
	os.Setenv("RECORDER_INACTIVITY_SEC", "600")
	defer func() {
		os.Unsetenv("RECORDER_PORT")
		os.Unsetenv("RECORDER_PROXY_PORT")
		os.Unsetenv("RECORDER_AUTH_TOKEN")
		os.Unsetenv("RECORDER_MAX_DURATION_SEC")
		os.Unsetenv("RECORDER_INACTIVITY_SEC")
	}()

	cfg := Load()

	if cfg.Port != 9000 {
		t.Errorf("Port = %d, want 9000", cfg.Port)
	}
	if cfg.ProxyPort != 9001 {
		t.Errorf("ProxyPort = %d, want 9001", cfg.ProxyPort)
	}
	if cfg.AuthToken != "secret-token" {
		t.Errorf("AuthToken = %q, want secret-token", cfg.AuthToken)
	}
	if cfg.MaxDurationSec != 7200 {
		t.Errorf("MaxDurationSec = %d, want 7200", cfg.MaxDurationSec)
	}
	if cfg.InactivitySec != 600 {
		t.Errorf("InactivitySec = %d, want 600", cfg.InactivitySec)
	}
}

func TestLoadInvalidInt(t *testing.T) {
	os.Setenv("RECORDER_PORT", "invalid")
	defer os.Unsetenv("RECORDER_PORT")

	cfg := Load()

	if cfg.Port != 8081 {
		t.Errorf("Port = %d, want 8081 (default on invalid)", cfg.Port)
	}
}
