// Package metrics endpoint tracking for per-endpoint metrics aggregation.
package metrics

import (
	"encoding/json"
	"sync"
)

// EndpointKey identifies a unique endpoint for metrics aggregation.
type EndpointKey struct {
	Method string `json:"method"`
	URL    string `json:"url"`
	Name   string `json:"name"` // k6 tag name override
}

// EndpointMetrics are the aggregated metrics for one endpoint.
type EndpointMetrics struct {
	Key          EndpointKey `json:"key"`
	Requests     int64       `json:"requests"`
	Failures     int64       `json:"failures"`
	SumDuration  float64     `json:"-"` // internal for avg calculation
	AvgDuration  float64     `json:"avgDurationMs"`
	MinDuration  float64     `json:"minDurationMs"`
	MaxDuration  float64     `json:"maxDurationMs"`
	P95Duration  float64     `json:"p95DurationMs"`
	Durations    []float64   `json:"-"` // for percentile calculation
}

// FailureGroup groups failures by endpoint, status code, and error type.
type FailureGroup struct {
	Key      FailureKey       `json:"key"`
	Count    int64            `json:"count"`
	Samples  []FailureSample  `json:"samples"` // max 20 samples
}

// FailureKey identifies a unique failure type.
type FailureKey struct {
	Method    string `json:"method"`
	URL       string `json:"url"`
	Status    int    `json:"status"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// FailureSample is one example of a failure.
type FailureSample struct {
	Timestamp int64  `json:"timestamp"` // ms since epoch
	Duration  float64 `json:"durationMs"`
	Error     string `json:"error,omitempty"`
}

// EndpointsTracker tracks per-endpoint metrics and failure groups.
type EndpointsTracker struct {
	mu       sync.Mutex
	endpoints map[string]*EndpointMetrics
	failures  map[string]*FailureGroup
	maxSamples int
}

// NewEndpointsTracker creates a new tracker with the given max samples per failure group.
func NewEndpointsTracker(maxSamples int) *EndpointsTracker {
	if maxSamples <= 0 {
		maxSamples = 20
	}
	return &EndpointsTracker{
		endpoints:  make(map[string]*EndpointMetrics),
		failures:   make(map[string]*FailureGroup),
		maxSamples: maxSamples,
	}
}

// RecordRequest records a successful request to an endpoint.
func (t *EndpointsTracker) RecordRequest(method, url, name string, duration float64) {
	t.mu.Lock()
	defer t.mu.Unlock()

	key := EndpointKey{Method: method, URL: url, Name: name}
	keyStr := t.keyString(key)

	ep, ok := t.endpoints[keyStr]
	if !ok {
		ep = &EndpointMetrics{
			Key:         key,
			MinDuration: duration,
			MaxDuration: duration,
			Durations:   make([]float64, 0, 100),
		}
		t.endpoints[keyStr] = ep
	}

	ep.Requests++
	ep.SumDuration += duration
	ep.AvgDuration = ep.SumDuration / float64(ep.Requests)
	if duration < ep.MinDuration {
		ep.MinDuration = duration
	}
	if duration > ep.MaxDuration {
		ep.MaxDuration = duration
	}
	// Keep samples for percentile (limited to 1000)
	if len(ep.Durations) < 1000 {
		ep.Durations = append(ep.Durations, duration)
	}
}

// RecordFailure records a failed request.
func (t *EndpointsTracker) RecordFailure(method, url string, status int, errorCode, errorMsg string, duration float64, timestamp int64) {
	t.mu.Lock()
	defer t.mu.Unlock()

	key := FailureKey{Method: method, URL: url, Status: status, ErrorCode: errorCode}
	keyStr := t.failureKeyString(key)

	fg, ok := t.failures[keyStr]
	if !ok {
		fg = &FailureGroup{
			Key:     key,
			Samples: make([]FailureSample, 0, t.maxSamples),
		}
		t.failures[keyStr] = fg
	}

	fg.Count++
	if len(fg.Samples) < t.maxSamples {
		fg.Samples = append(fg.Samples, FailureSample{
			Timestamp: timestamp,
			Duration:  duration,
			Error:     errorMsg,
		})
	}

	// Also record in endpoints for the failure count
	epKey := EndpointKey{Method: method, URL: url}
	epKeyStr := t.keyString(epKey)
	if ep, ok := t.endpoints[epKeyStr]; ok {
		ep.Failures++
	} else {
		t.endpoints[epKeyStr] = &EndpointMetrics{
			Key:      epKey,
			Failures: 1,
		}
	}
}

// GetEndpoints returns all tracked endpoint metrics.
func (t *EndpointsTracker) GetEndpoints() []EndpointMetrics {
	t.mu.Lock()
	defer t.mu.Unlock()

	result := make([]EndpointMetrics, 0, len(t.endpoints))
	for _, ep := range t.endpoints {
		// Calculate P95 if we have samples
		if len(ep.Durations) > 0 {
			ep.P95Duration = percentile95(ep.Durations)
		}
		result = append(result, *ep)
	}
	return result
}

// GetFailures returns all tracked failure groups.
func (t *EndpointsTracker) GetFailures() []FailureGroup {
	t.mu.Lock()
	defer t.mu.Unlock()

	result := make([]FailureGroup, 0, len(t.failures))
	for _, fg := range t.failures {
		result = append(result, *fg)
	}
	return result
}

// ToJSON encodes the tracker state to JSON.
func (t *EndpointsTracker) ToJSON() ([]byte, error) {
	data := struct {
		Endpoints []EndpointMetrics `json:"endpoints"`
		Failures  []FailureGroup    `json:"failures"`
	}{
		Endpoints: t.GetEndpoints(),
		Failures:  t.GetFailures(),
	}
	return json.Marshal(data)
}

// GetEndpointsJSON returns the endpoints as JSON (implements runs.EndpointsData).
func (t *EndpointsTracker) GetEndpointsJSON() ([]byte, error) {
	endpoints := t.GetEndpoints()
	return json.Marshal(struct {
		Version   int               `json:"version"`
		Endpoints []EndpointMetrics `json:"endpoints"`
	}{
		Version:   1,
		Endpoints: endpoints,
	})
}

// GetFailuresJSON returns the failures as JSON (implements runs.EndpointsData).
func (t *EndpointsTracker) GetFailuresJSON() ([]byte, error) {
	failures := t.GetFailures()
	return json.Marshal(struct {
		Version  int            `json:"version"`
		Failures []FailureGroup `json:"failures"`
	}{
		Version:  1,
		Failures: failures,
	})
}

func (t *EndpointsTracker) keyString(key EndpointKey) string {
	return key.Method + "|" + key.URL + "|" + key.Name
}

func (t *EndpointsTracker) failureKeyString(key FailureKey) string {
	return key.Method + "|" + key.URL + "|" + string(rune(key.Status)) + "|" + key.ErrorCode
}

// percentile95 calculates the 95th percentile using nearest rank.
func percentile95(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	// Make a copy and sort
	sorted := make([]float64, len(samples))
	copy(sorted, samples)
	// Simple bubble sort for small arrays (we limit to 1000)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j] < sorted[i] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	rank := int(float64(len(sorted)) * 0.95)
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}
