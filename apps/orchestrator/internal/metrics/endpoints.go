// Package metrics endpoint tracking for per-endpoint metrics aggregation.
package metrics

import (
	"encoding/json"
	"sort"
	"strconv"
	"sync"
)

// EndpointKey identifies a unique endpoint for metrics aggregation.
//
// Grouping follows k6: the `name` tag is k6's grouping label (it defaults to
// the URL and is overridden for dynamic URLs, e.g. http.url templates), so an
// endpoint row is keyed by method + name, falling back to the URL when name is
// empty. URL keeps the first URL seen for display.
type EndpointKey struct {
	Method string
	URL    string
	Name   string
}

// EndpointMetrics are the aggregated metrics for one endpoint (internal).
type EndpointMetrics struct {
	Key         EndpointKey
	Requests    int64
	Failures    int64
	SumDuration float64
	MinDuration float64
	MaxDuration float64
	Durations   []float64 // for percentile calculation (bounded)
}

// FailureGroup groups failures by endpoint, status code, and error code (internal).
type FailureGroup struct {
	Key        FailureKey
	Count      int64
	LastError  string
	LastSeenMs int64
	Samples    []FailureSample // max maxSamples samples
}

// FailureKey identifies a unique failure type.
type FailureKey struct {
	Method    string
	URL       string
	Name      string
	Status    int
	ErrorCode string
}

// FailureSample is one example of a failure.
type FailureSample struct {
	Timestamp int64
	Duration  float64
	Error     string
}

// EndpointRow is the flat wire DTO for one endpoint (GET /runs/{id}/endpoints).
type EndpointRow struct {
	Method        string  `json:"method"`
	URL           string  `json:"url"`
	Name          string  `json:"name"`
	Requests      int64   `json:"requests"`
	Failures      int64   `json:"failures"`
	ErrorRate     float64 `json:"errorRate"` // failures/requests, 0-1; 0 without requests
	AvgDurationMs float64 `json:"avgDurationMs"`
	MinDurationMs float64 `json:"minDurationMs"`
	MaxDurationMs float64 `json:"maxDurationMs"`
	P95DurationMs float64 `json:"p95DurationMs"`
}

// FailureRow is the flat wire DTO for one failure group (GET /runs/{id}/failures).
type FailureRow struct {
	Method     string `json:"method"`
	URL        string `json:"url"`
	Status     int    `json:"status"` // 0 = network error (no HTTP response)
	ErrorCode  string `json:"errorCode"`
	Count      int64  `json:"count"`
	LastError  string `json:"lastError"`
	LastSeenMs int64  `json:"lastSeenMs"`
}

// EndpointsTracker tracks per-endpoint metrics and failure groups.
type EndpointsTracker struct {
	mu         sync.Mutex
	endpoints  map[string]*EndpointMetrics
	failures   map[string]*FailureGroup
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

// endpoint returns (creating if needed) the row for method+name/url.
// Caller holds t.mu.
func (t *EndpointsTracker) endpoint(method, url, name string) *EndpointMetrics {
	keyStr := endpointKeyString(method, url, name)
	ep, ok := t.endpoints[keyStr]
	if !ok {
		ep = &EndpointMetrics{
			Key:       EndpointKey{Method: method, URL: url, Name: name},
			Durations: make([]float64, 0, 100),
		}
		t.endpoints[keyStr] = ep
	}
	return ep
}

// RecordRequest records one request (failed or not) with its duration.
func (t *EndpointsTracker) RecordRequest(method, url, name string, duration float64) {
	t.mu.Lock()
	defer t.mu.Unlock()

	ep := t.endpoint(method, url, name)
	if ep.Requests == 0 || duration < ep.MinDuration {
		ep.MinDuration = duration
	}
	if ep.Requests == 0 || duration > ep.MaxDuration {
		ep.MaxDuration = duration
	}
	ep.Requests++
	ep.SumDuration += duration
	// Keep samples for percentile (limited to 1000)
	if len(ep.Durations) < 1000 {
		ep.Durations = append(ep.Durations, duration)
	}
}

// RecordFailure records one failed request: it increments the failures of the
// same endpoint row RecordRequest uses (it does not count a request) and the
// failure group keyed by endpoint + status + errorCode.
func (t *EndpointsTracker) RecordFailure(method, url, name string, status int, errorCode, errorMsg string, duration float64, timestamp int64) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.endpoint(method, url, name).Failures++

	key := FailureKey{Method: method, URL: url, Name: name, Status: status, ErrorCode: errorCode}
	keyStr := endpointKeyString(method, url, name) + "|" + strconv.Itoa(status) + "|" + errorCode
	fg, ok := t.failures[keyStr]
	if !ok {
		fg = &FailureGroup{Key: key, Samples: make([]FailureSample, 0, t.maxSamples)}
		t.failures[keyStr] = fg
	}
	fg.Count++
	if timestamp >= fg.LastSeenMs {
		fg.LastSeenMs = timestamp
		if errorMsg != "" {
			fg.LastError = errorMsg
		}
	} else if fg.LastError == "" {
		fg.LastError = errorMsg
	}
	if len(fg.Samples) < t.maxSamples {
		fg.Samples = append(fg.Samples, FailureSample{Timestamp: timestamp, Duration: duration, Error: errorMsg})
	}
}

// EndpointRows returns the flat endpoint rows sorted by requests desc.
func (t *EndpointsTracker) EndpointRows() []EndpointRow {
	t.mu.Lock()
	defer t.mu.Unlock()

	rows := make([]EndpointRow, 0, len(t.endpoints))
	for _, ep := range t.endpoints {
		row := EndpointRow{
			Method:        ep.Key.Method,
			URL:           ep.Key.URL,
			Name:          ep.Key.Name,
			Requests:      ep.Requests,
			Failures:      ep.Failures,
			MinDurationMs: ep.MinDuration,
			MaxDurationMs: ep.MaxDuration,
		}
		if ep.Requests > 0 {
			row.ErrorRate = clamp01(float64(ep.Failures) / float64(ep.Requests))
			row.AvgDurationMs = ep.SumDuration / float64(ep.Requests)
		}
		if len(ep.Durations) > 0 {
			row.P95DurationMs = percentile95(ep.Durations)
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Requests != rows[j].Requests {
			return rows[i].Requests > rows[j].Requests
		}
		if rows[i].Failures != rows[j].Failures {
			return rows[i].Failures > rows[j].Failures
		}
		return rows[i].Method+rows[i].Name+rows[i].URL < rows[j].Method+rows[j].Name+rows[j].URL
	})
	return rows
}

// FailureRows returns the flat failure groups sorted by count desc.
func (t *EndpointsTracker) FailureRows() []FailureRow {
	t.mu.Lock()
	defer t.mu.Unlock()

	rows := make([]FailureRow, 0, len(t.failures))
	for _, fg := range t.failures {
		rows = append(rows, FailureRow{
			Method:     fg.Key.Method,
			URL:        fg.Key.URL,
			Status:     fg.Key.Status,
			ErrorCode:  fg.Key.ErrorCode,
			Count:      fg.Count,
			LastError:  fg.LastError,
			LastSeenMs: fg.LastSeenMs,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Count != rows[j].Count {
			return rows[i].Count > rows[j].Count
		}
		if rows[i].Status != rows[j].Status {
			return rows[i].Status < rows[j].Status
		}
		return rows[i].Method+rows[i].URL+rows[i].ErrorCode < rows[j].Method+rows[j].URL+rows[j].ErrorCode
	})
	return rows
}

// ToJSON encodes the tracker state to JSON.
func (t *EndpointsTracker) ToJSON() ([]byte, error) {
	return json.Marshal(struct {
		Endpoints []EndpointRow `json:"endpoints"`
		Failures  []FailureRow  `json:"failures"`
	}{
		Endpoints: t.EndpointRows(),
		Failures:  t.FailureRows(),
	})
}

// GetEndpointsJSON returns {version:1, endpoints:[EndpointRow]} (implements runs.EndpointsData).
func (t *EndpointsTracker) GetEndpointsJSON() ([]byte, error) {
	return json.Marshal(struct {
		Version   int           `json:"version"`
		Endpoints []EndpointRow `json:"endpoints"`
	}{
		Version:   1,
		Endpoints: t.EndpointRows(),
	})
}

// GetFailuresJSON returns {version:1, failures:[FailureRow]} (implements runs.EndpointsData).
func (t *EndpointsTracker) GetFailuresJSON() ([]byte, error) {
	return json.Marshal(struct {
		Version  int          `json:"version"`
		Failures []FailureRow `json:"failures"`
	}{
		Version:  1,
		Failures: t.FailureRows(),
	})
}

// endpointKeyString keys a row by method + name, falling back to url.
func endpointKeyString(method, url, name string) string {
	group := name
	if group == "" {
		group = url
	}
	return method + "|" + group
}

// percentile95 calculates the 95th percentile using nearest rank.
func percentile95(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	rank := int(float64(len(sorted)) * 0.95)
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}
