// Package config loads orchestrator settings from environment variables.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config holds the orchestrator runtime settings.
type Config struct {
	Addr, K6Image, ServiceToken, LogLevel, Network string
	MaxConcurrentRuns, MaxVUsPerRun, RunTimeoutMS  int
	// Per-run resource ceilings enforced by the runs API before any launch.
	MaxMemoryMiBPerRun, MaxCPUMillisPerRun int
	// K6F9-01: Allowed target hosts/patterns for K6 tests (security)
	AllowedTargets []string
}

// Defaults are applied only when a variable is absent from the environment.
const (
	DefaultAddr               = ":8080"
	DefaultK6Image            = "grafana/k6"
	DefaultNetwork            = "bridge"
	DefaultMaxConcurrentRuns  = 3
	DefaultMaxVUsPerRun       = 500
	DefaultMaxMemoryMiBPerRun = 4096
	DefaultMaxCPUMillisPerRun = 4000
	DefaultRunTimeoutMS       = 3600000
	DefaultLogLevel           = "info"
)

// logLevels is the closed set accepted for LOG_LEVEL.
var logLevels = []string{"debug", "info", "warn", "error"}

// Load reads configuration from the process environment. Defaults apply only
// to absent variables; explicit invalid values are descriptive errors naming
// the variable — no coercion (Phase 1 policy). An empty SERVICE_TOKEN is
// valid and fail-closed: the auth middleware (K6F2-02) rejects every request.
func Load() (Config, error) {
	var cfg Config
	var err error
	if cfg.Addr, err = strEnv("ORCHESTRATOR_ADDR", DefaultAddr, false); err != nil {
		return Config{}, err
	}
	if cfg.K6Image, err = strEnv("K6_IMAGE", DefaultK6Image, false); err != nil {
		return Config{}, err
	}
	if cfg.Network, err = strEnv("ORCHESTRATOR_NETWORK", DefaultNetwork, false); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrentRuns, err = intEnv("MAX_CONCURRENT_RUNS", DefaultMaxConcurrentRuns); err != nil {
		return Config{}, err
	}
	if cfg.MaxVUsPerRun, err = intEnv("MAX_VUS_PER_RUN", DefaultMaxVUsPerRun); err != nil {
		return Config{}, err
	}
	if cfg.MaxMemoryMiBPerRun, err = intEnv("MAX_MEMORY_MIB_PER_RUN", DefaultMaxMemoryMiBPerRun); err != nil {
		return Config{}, err
	}
	if cfg.MaxCPUMillisPerRun, err = intEnv("MAX_CPU_MILLIS_PER_RUN", DefaultMaxCPUMillisPerRun); err != nil {
		return Config{}, err
	}
	if cfg.RunTimeoutMS, err = intEnv("RUN_TIMEOUT_MS", DefaultRunTimeoutMS); err != nil {
		return Config{}, err
	}
	if cfg.ServiceToken, err = strEnv("SERVICE_TOKEN", "", true); err != nil {
		return Config{}, err
	}
	if cfg.LogLevel, err = levelEnv("LOG_LEVEL"); err != nil {
		return Config{}, err
	}
	// K6F9-01: Allowed targets (comma-separated list of host patterns)
	cfg.AllowedTargets = targetsEnv("ALLOWED_TARGETS")
	return cfg, nil
}

// strEnv returns def when the variable is absent; empty is rejected unless allowEmpty.
func strEnv(name, def string, allowEmpty bool) (string, error) {
	value, present := os.LookupEnv(name)
	if !present {
		return def, nil
	}
	if value == "" && !allowEmpty {
		return "", fmt.Errorf("%s: must not be empty", name)
	}
	return value, nil
}

// intEnv returns def when the variable is absent and a positive integer otherwise.
func intEnv(name string, def int) (int, error) {
	raw, present := os.LookupEnv(name)
	if !present {
		return def, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not an integer", name, raw)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s: %q must be a positive integer", name, raw)
	}
	return value, nil
}

// levelEnv returns the default when absent and validates the closed level set otherwise.
func levelEnv(name string) (string, error) {
	raw, present := os.LookupEnv(name)
	if !present {
		return DefaultLogLevel, nil
	}
	for _, level := range logLevels {
		if raw == level {
			return raw, nil
		}
	}
	return "", fmt.Errorf("%s: %q is not one of debug|info|warn|error", name, raw)
}

// targetsEnv parses a comma-separated list of allowed target patterns.
// Empty or absent means no restrictions (all targets allowed).
func targetsEnv(name string) []string {
	raw, present := os.LookupEnv(name)
	if !present || raw == "" {
		return nil
	}
	var targets []string
	for _, t := range strings.Split(raw, ",") {
		t = strings.TrimSpace(t)
		if t != "" {
			targets = append(targets, strings.ToLower(t))
		}
	}
	return targets
}

// IsTargetAllowed checks if a URL's host matches the allowed targets list.
// If AllowedTargets is empty, all targets are allowed (permissive mode).
// Patterns support:
//   - Exact match: "example.com"
//   - Wildcard subdomain: "*.example.com" (matches sub.example.com but not example.com)
//   - Port-specific: "example.com:8080"
func (c *Config) IsTargetAllowed(targetURL string) (bool, error) {
	if len(c.AllowedTargets) == 0 {
		return true, nil // No restrictions
	}

	parsed, err := url.Parse(targetURL)
	if err != nil {
		return false, fmt.Errorf("invalid URL: %w", err)
	}

	host := strings.ToLower(parsed.Host)
	if host == "" {
		return false, fmt.Errorf("URL has no host")
	}

	for _, pattern := range c.AllowedTargets {
		if matchesPattern(host, pattern) {
			return true, nil
		}
	}

	return false, nil
}

// matchesPattern checks if host matches pattern.
func matchesPattern(host, pattern string) bool {
	// Exact match
	if host == pattern {
		return true
	}

	// Wildcard subdomain match: *.example.com
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return true
		}
	}

	return false
}
