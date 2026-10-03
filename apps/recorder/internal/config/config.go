// Package config provides configuration for the recorder service.
package config

import (
	"os"
	"strconv"
)

// Config holds recorder service configuration.
type Config struct {
	Port           int
	ProxyPort      int
	AuthToken      string
	MaxDurationSec int
	InactivitySec  int
}

// Load reads configuration from environment variables with defaults.
func Load() Config {
	return Config{
		Port:           envInt("RECORDER_PORT", 8081),
		ProxyPort:      envInt("RECORDER_PROXY_PORT", 8082),
		AuthToken:      os.Getenv("RECORDER_AUTH_TOKEN"),
		MaxDurationSec: envInt("RECORDER_MAX_DURATION_SEC", 3600),
		InactivitySec:  envInt("RECORDER_INACTIVITY_SEC", 300),
	}
}

func envInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}
