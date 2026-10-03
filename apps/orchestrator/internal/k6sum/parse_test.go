package k6sum_test

import (
	"fmt"
	"strings"
	"testing"

	"k6flow/apps/orchestrator/internal/k6sum"
	"k6flow/apps/orchestrator/internal/runs"
)

// Fixture lines mirroring the k6 `--out json` JSON-LINES stream.
const descReqs = `{"type":"Metric","metric":{"type":"Counter","name":"http_reqs","help":"Total number of HTTP requests","contains":"count","unit":"count"}}`
const descFailed = `{"type":"Metric","metric":{"type":"Rate","name":"http_req_failed","help":"Ratio of failed HTTP requests","contains":"rate","unit":"ratio"}}`

// descCheck is the exact descriptor grafana/k6 v2.3.0 emitted in the K6F2-05
// conformance probe (name "checks", type rate).
const descCheck = `{"type":"Metric","data":{"name":"checks","type":"rate","contains":"default","thresholds":[],"submetrics":null},"metric":"checks"}`

// descCheckLegacy is the pre-conformance descriptor used by the frozen
// K6F2-04-era fixtures (see TestParseLegacyCheckNameStillCounts).
const descCheckLegacy = `{"type":"Metric","metric":{"type":"Counter","name":"check","help":"Number of failed checks","contains":"count","unit":"count"}}`
const descDuration = `{"type":"Metric","metric":{"type":"Trend","name":"http_req_duration","help":"Duration of HTTP request in ms","contains":"time","unit":"ms"}}`

// point renders one k6 Point sample line for the given metric and value.
func point(metric string, value float64) string {
	return fmt.Sprintf(`{"type":"Point","metric":%q,"data":{"time":"2026-01-01T00:00:00.000000000Z","value":%v,"tags":{"group":"::api"}}}`, metric, value)
}

// stream joins fixture lines into one JSON-LINES payload.
func stream(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}

// parse runs k6sum.Parse over the fixture and fails the test on error.
func parse(t *testing.T, input string) runs.Summary {
	t.Helper()
	summary, err := k6sum.Parse(strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse(%q) unexpected error: %v", input, err)
	}
	return summary
}

func TestParseCountsRequestsFromHttpReqPoints(t *testing.T) {
	summary := parse(t, stream(descReqs, point("http_reqs", 1), point("http_reqs", 1), point("http_reqs", 1)))
	if summary.Totals.Requests != 3 {
		t.Errorf("Requests = %d, want 3", summary.Totals.Requests)
	}
	if summary.Totals.Errors != 0 || summary.Totals.FailedChecks != 0 {
		t.Errorf("other totals = %+v, want zeros", summary.Totals)
	}
}

func TestParseSumsHttpReqFailedRatePoints(t *testing.T) {
	summary := parse(t, stream(descFailed,
		point("http_req_failed", 0), point("http_req_failed", 1),
		point("http_req_failed", 0), point("http_req_failed", 1), point("http_req_failed", 0)))
	if summary.Totals.Errors != 2 {
		t.Errorf("Errors = %d, want 2 (sum of 0/1 samples)", summary.Totals.Errors)
	}
	if summary.Totals.Requests != 0 {
		t.Errorf("Requests = %d, want 0", summary.Totals.Requests)
	}
}

func TestParseCountsFailedCheckPoints(t *testing.T) {
	summary := parse(t, stream(descCheck,
		point("checks", 1), point("checks", 0), point("checks", 1),
		point("checks", 0), point("checks", 0)))
	if summary.Totals.FailedChecks != 3 {
		t.Errorf("FailedChecks = %d, want 3 (value==0 points only)", summary.Totals.FailedChecks)
	}
}

// TestParseLegacyCheckNameStillCounts documents the MetricCheckLegacy alias:
// the pre-conformance "check" spelling keeps counting failed checks, because
// the frozen K6F2-04 engine fixtures (internal/engine/engine_test.go) still
// carry that name and must not silently change meaning.
func TestParseLegacyCheckNameStillCounts(t *testing.T) {
	summary := parse(t, stream(descCheckLegacy, point("check", 1), point("check", 0)))
	if summary.Totals.FailedChecks != 1 {
		t.Errorf("FailedChecks = %d, want 1 (legacy \"check\" name still counted)", summary.Totals.FailedChecks)
	}
}

// TestParseCountsRealK6ChecksMetric pins the K6F2-05 conformance finding:
// the real grafana/k6 v2.3.0 image emits the metric name "checks"
// (plural, type rate), not the "check" assumed by K6F2-04, and value 0
// still marks a failed check.
func TestParseCountsRealK6ChecksMetric(t *testing.T) {
	summary := parse(t, stream(
		`{"type":"Metric","data":{"name":"checks","type":"rate","contains":"default"},"metric":"checks"}`,
		point("checks", 1), point("checks", 0), point("checks", 1)))
	if summary.Totals.FailedChecks != 1 {
		t.Errorf("FailedChecks = %d, want 1 (real k6 name \"checks\", value 0)", summary.Totals.FailedChecks)
	}
	if summary.Totals.Requests != 0 {
		t.Errorf("Requests = %d, want 0", summary.Totals.Requests)
	}
}

func TestParseAggregatesAllTotalsFromMixedStream(t *testing.T) {
	summary := parse(t, stream(
		descReqs, descFailed, descCheck, descDuration,
		point("http_reqs", 1), point("http_reqs", 1),
		point("http_req_failed", 0), point("http_req_failed", 1),
		point("checks", 1), point("checks", 0),
		point("http_req_duration", 42.5),
	))
	want := runs.Totals{Requests: 2, Errors: 1, FailedChecks: 1}
	if summary.Totals != want {
		t.Errorf("Totals = %+v, want %+v", summary.Totals, want)
	}
	if summary.LatencyMs.Avg != 42.5 {
		t.Errorf("Latency avg = %v, want 42.5", summary.LatencyMs.Avg)
	}
}

func TestParseLatencyQuantilesFromAllDurationSamples(t *testing.T) {
	var lines []string
	lines = append(lines, descDuration)
	for i := 1; i <= 10; i++ {
		lines = append(lines, point("http_req_duration", float64(i*10))) // 10..100
	}
	summary := parse(t, stream(lines...))
	want := runs.LatencyMs{Avg: 55, P90: 90, P95: 100, P99: 100}
	if summary.LatencyMs != want {
		t.Errorf("LatencyMs = %+v, want %+v (nearest-rank over sorted samples)", summary.LatencyMs, want)
	}
}

func TestParseLatencySingleSampleYieldsSameQuantiles(t *testing.T) {
	summary := parse(t, stream(descDuration, point("http_req_duration", 12.345)))
	want := runs.LatencyMs{Avg: 12.345, P90: 12.345, P95: 12.345, P99: 12.345}
	if summary.LatencyMs != want {
		t.Errorf("LatencyMs = %+v, want %+v", summary.LatencyMs, want)
	}
}

func TestParseLatencyRoundsToThreeDecimals(t *testing.T) {
	summary := parse(t, stream(descDuration,
		point("http_req_duration", 0.66666), point("http_req_duration", 1.99999)))
	if summary.LatencyMs.Avg != 1.333 {
		t.Errorf("Avg = %v, want 1.333 (round to 3 decimals)", summary.LatencyMs.Avg)
	}
	if summary.LatencyMs.P90 != 2 || summary.LatencyMs.P95 != 2 || summary.LatencyMs.P99 != 2 {
		t.Errorf("quantiles = (%v,%v,%v), want (2,2,2)", summary.LatencyMs.P90, summary.LatencyMs.P95, summary.LatencyMs.P99)
	}
}

func TestParseNoSamplesYieldsAllZeroSummary(t *testing.T) {
	for name, input := range map[string]string{
		"empty":           "",
		"descriptorsOnly": stream(descReqs, descFailed, descCheck, descDuration),
		"blankLinesOnly":  stream("", "", "  "),
	} {
		t.Run(name, func(t *testing.T) {
			summary := parse(t, input)
			if summary.Totals != (runs.Totals{}) {
				t.Errorf("Totals = %+v, want all zeros", summary.Totals)
			}
			if summary.LatencyMs != (runs.LatencyMs{}) {
				t.Errorf("LatencyMs = %+v, want all zeros", summary.LatencyMs)
			}
			if summary.ThresholdsPassed {
				t.Error("ThresholdsPassed = true, want false (Parse never sets it)")
			}
		})
	}
}

func TestParseIgnoresUnknownTypesAndMetricsDefensively(t *testing.T) {
	summary := parse(t, stream(
		`{"type":"Summary","data":{"root_group":{"name":""}}}`,
		`{"type":"Point","metric":"vus","data":{"time":"2026-01-01T00:00:00Z","value":10,"tags":{}}}`,
		`{"type":"Group","data":{"name":"::api"}}`,
		`{"type":"TotallyUnknown"}`,
		`{}`,
		descReqs,
		point("http_reqs", 1),
	))
	if summary.Totals.Requests != 1 {
		t.Errorf("Requests = %d, want 1 (only the known point counted)", summary.Totals.Requests)
	}
	if summary.Totals != (runs.Totals{Requests: 1}) {
		t.Errorf("Totals = %+v, want {1 0 0}", summary.Totals)
	}
}

func TestParseMalformedLineFailsWithoutPanic(t *testing.T) {
	cases := map[string]string{
		"notJSON":         "not json\n",
		"truncatedObject": `{"type":"Point","metric":"http_reqs"` + "\n",
		"jsonArray":       "[1,2,3]\n",
		"nonNumericValue": `{"type":"Point","metric":"http_reqs","data":{"value":"high"}}` + "\n",
		"pointNoData":     `{"type":"Point","metric":"http_reqs"}` + "\n",
		"pointBadMetric":  `{"type":"Point","metric":{"name":"http_reqs"},"data":{"value":1}}` + "\n",
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			summary, err := k6sum.Parse(strings.NewReader(input))
			if err == nil {
				t.Fatalf("Parse(%q) error = nil, want malformed-line error", input)
			}
			if summary != (runs.Summary{}) {
				t.Errorf("Parse returned %+v on error, want zero Summary", summary)
			}
			if !strings.Contains(err.Error(), "line 1") {
				t.Errorf("error %q does not name the failing line", err)
			}
		})
	}
}

func TestParseMalformedLineAfterValidPrefixFailsWholeParse(t *testing.T) {
	input := stream(descReqs, point("http_reqs", 1)) + "{broken\n"
	summary, err := k6sum.Parse(strings.NewReader(input))
	if err == nil {
		t.Fatal("error = nil, want failure (fail-the-summary policy)")
	}
	if summary != (runs.Summary{}) {
		t.Errorf("Parse returned %+v on error, want zero Summary", summary)
	}
}

func TestParseRejectsOversizedLine(t *testing.T) {
	input := strings.Repeat("x", k6sum.MaxLineBytes+1) + "\n"
	summary, err := k6sum.Parse(strings.NewReader(input))
	if err == nil {
		t.Fatal("error = nil, want oversized-line guard error")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("%d bytes", k6sum.MaxLineBytes)) {
		t.Errorf("error %q does not state the %d-byte bound", err, k6sum.MaxLineBytes)
	}
	if summary != (runs.Summary{}) {
		t.Errorf("Parse returned %+v on error, want zero Summary", summary)
	}
}

func TestOutcomeForExitMapping(t *testing.T) {
	cases := []struct {
		code            int
		wantStatus      runs.Status
		wantPassedValue bool
	}{
		{0, runs.StatusFinished, true},
		{99, runs.StatusFinished, false},
		{1, runs.StatusFailed, false},
		{2, runs.StatusFailed, false},
		{42, runs.StatusFailed, false},
		{100, runs.StatusFailed, false},
		{127, runs.StatusFailed, false},
		{137, runs.StatusFailed, false},
		{-1, runs.StatusFailed, false},
	}
	for _, tc := range cases {
		status, passed := k6sum.OutcomeForExit(tc.code)
		if status != tc.wantStatus || passed != tc.wantPassedValue {
			t.Errorf("OutcomeForExit(%d) = (%q, %v), want (%q, %v)",
				tc.code, status, passed, tc.wantStatus, tc.wantPassedValue)
		}
	}
}
