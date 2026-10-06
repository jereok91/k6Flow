// Package k6sum parses the k6 `--out json` JSON-LINES stream and aggregates
// the approved contract-04 terminal summary (totals, latency, thresholds).
// It performs no I/O beyond reading the supplied io.Reader and never panics:
// every failure is a returned error (fail-the-summary policy, see DECISIONES).
package k6sum

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"

	"k6flow/apps/orchestrator/internal/runs"
)

// The k6 metric names the summary aggregates (the check name was proven
// against the real grafana/k6 v2.3.0 image in K6F2-05 — see MetricCheck):
//   - http_reqs: Counter points, one per HTTP request → totals.requests count
//   - http_req_failed: Rate points with 0/1 samples → totals.errors = rounded sum
//   - checks: Rate points with value 0 mark a failed check → totals.failedChecks count
//   - http_req_duration: Trend points in milliseconds → latency quantiles
const (
	MetricRequests = "http_reqs"
	MetricFailed   = "http_req_failed"
	// MetricCheck is k6's real check metric: the K6F2-05 conformance probe
	// against grafana/k6 v2.3.0 recorded the exact name "checks" (type
	// rate, value 1 = passed, 0 = failed), replacing the "check" name
	// assumed by K6F2-04 (R3-k6-checks-name resolved).
	MetricCheck = "checks"
	// MetricCheckLegacy keeps the pre-conformance "check" spelling counting
	// so legacy JSON-LINES streams (and the frozen engine fixtures) still
	// fold into failedChecks; real k6 never emits it.
	MetricCheckLegacy = "check"
	MetricDurationMs  = "http_req_duration"
	// MetricIterations counts completed VU iterations.
	MetricIterations = "iterations"
	// MetricDataReceived and MetricDataSent are byte counters.
	MetricDataReceived = "data_received"
	MetricDataSent     = "data_sent"
)

// MaxLineBytes bounds one stream line: a line longer than 1 MiB is rejected
// instead of buffered, capping scanner memory independent of input size.
const MaxLineBytes = 1 << 20

// message is the k6 JSON-LINES envelope. Data stays raw so non-Point message
// types (whose payloads are objects or arrays) never fail decoding.
type message struct {
	Type   string          `json:"type"`
	Metric json.RawMessage `json:"metric"`
	Data   json.RawMessage `json:"data"`
}

// pointData is the `data` object of a Point sample; a Point line that fails to
// decode here (e.g. a non-numeric value) is a malformed line.
type pointData struct {
	Value float64 `json:"value"`
}

// Parse reads the k6 JSON-LINES stream and returns the aggregated summary.
// Policy: blank lines and unknown message types/metrics are skipped
// defensively; a malformed JSON line, an undecodable Point, or an oversized
// line aborts the whole parse with a zero Summary and an error naming the
// failing line — a corrupt stream must not yield a trusted summary.
// ThresholdsPassed is never set here (see OutcomeForExit).
func Parse(r io.Reader) (runs.Summary, error) {
	agg := aggregator{}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), MaxLineBytes)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var msg message
		if err := json.Unmarshal(line, &msg); err != nil {
			return runs.Summary{}, fmt.Errorf("k6sum: malformed line %d: %w", lineNo, err)
		}
		switch msg.Type {
		case "Metric":
			// Descriptor line: metric metadata only, nothing to aggregate.
			continue
		case "Point":
			var name string
			if err := json.Unmarshal(msg.Metric, &name); err != nil {
				return runs.Summary{}, fmt.Errorf("k6sum: malformed point metric on line %d: %w", lineNo, err)
			}
			var data pointData
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				return runs.Summary{}, fmt.Errorf("k6sum: malformed point data on line %d: %w", lineNo, err)
			}
			agg.add(name, data.Value)
		default:
			// Unknown message types (Summary, Group, future additions) and
			// unknown metric names are ignored defensively.
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return runs.Summary{}, fmt.Errorf("k6sum: line exceeds %d bytes", MaxLineBytes)
		}
		return runs.Summary{}, fmt.Errorf("k6sum: read stream: %w", err)
	}
	return agg.summary(), nil
}

// OutcomeForExit maps the k6 process exit code to the terminal status and the
// thresholdsPassed flag (meaningful only for finished runs):
//
//	0   → finished, thresholdsPassed = true
//	99  → finished, thresholdsPassed = false  (k6 threshold-failure exit)
//	any other → failed,  thresholdsPassed = false (crash/engine failure;
//	            the engine stores no summary for failed runs)
func OutcomeForExit(code int) (runs.Status, bool) {
	switch code {
	case 0:
		return runs.StatusFinished, true
	case 99:
		return runs.StatusFinished, false
	default:
		return runs.StatusFailed, false
	}
}

// aggregator accumulates cumulative totals and all latency samples in memory.
// Holding every http_req_duration sample is the documented Phase 2 bound;
// streaming quantile aggregation is deferred to Phase 3 (see DECISIONES).
type aggregator struct {
	requests     int64
	failedSum    float64
	failedChecks int64
	latencies    []float64
	iterations   int64
	dataReceived float64
	dataSent     float64
}

// add folds one Point sample into the aggregate by metric name.
func (a *aggregator) add(name string, value float64) {
	switch name {
	case MetricRequests:
		a.requests++
	case MetricFailed:
		a.failedSum += value
	case MetricCheck, MetricCheckLegacy:
		if value == 0 {
			a.failedChecks++
		}
	case MetricDurationMs:
		a.latencies = append(a.latencies, value)
	case MetricIterations:
		a.iterations++
	case MetricDataReceived:
		a.dataReceived += value
	case MetricDataSent:
		a.dataSent += value
	}
}

// summary renders the contract totals and latency quantiles. No-sample inputs
// yield all-zero totals and zero latencies (the contract requires finite
// nonnegative numbers, not nulls — see DECISIONES).
func (a *aggregator) summary() runs.Summary {
	return runs.Summary{
		Totals: runs.Totals{
			Requests:     a.requests,
			Errors:       int64(math.Round(a.failedSum)),
			FailedChecks: a.failedChecks,
			Iterations:   a.iterations,
		},
		LatencyMs:    latencyOf(a.latencies),
		DataReceived: int64(a.dataReceived),
		DataSent:     int64(a.dataSent),
	}
}

// latencyOf computes avg and nearest-rank p90/p95/p99 over sorted samples,
// each rounded to 3 decimals (0.001 ms resolution).
func latencyOf(samples []float64) runs.LatencyMs {
	if len(samples) == 0 {
		return runs.LatencyMs{}
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	return runs.LatencyMs{
		Avg: round3(sum / float64(len(sorted))),
		P90: round3(percentile(sorted, 90)),
		P95: round3(percentile(sorted, 95)),
		P99: round3(percentile(sorted, 99)),
	}
}

// percentile returns the nearest-rank quantile of a nonempty sorted slice:
// rank = ceil(p/100 · n), clamped to [1, n], index rank-1. No interpolation.
func percentile(sorted []float64, p int) float64 {
	rank := int(math.Ceil(float64(p) / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// round3 rounds to 3 decimal places (half away from zero) so serialized
// summaries stay deterministic and contract-conforming (finite, nonnegative).
func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}
