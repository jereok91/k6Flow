package metrics

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"k6flow/apps/orchestrator/internal/k6sum"
)

// testAnchor is the fixed run anchor: window n covers
// [n·1000ms, (n+1)·1000ms) run-relative to it.
var testAnchor = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

// recordingSink captures emitted frames for assertions (thread-safe under -race).
type recordingSink struct {
	mu     sync.Mutex
	frames []MetricsFrame
}

func (s *recordingSink) OnFrame(f MetricsFrame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, f)
}

func (s *recordingSink) snapshot() []MetricsFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MetricsFrame(nil), s.frames...)
}

// pointAtTime builds a k6 JSON-LINES Point line stamped at ts.
func pointAtTime(metric string, ts time.Time, value string) string {
	return fmt.Sprintf(`{"type":"Point","metric":%q,"data":{"time":%q,"value":%s,"tags":{}}}`,
		metric, ts.UTC().Format(time.RFC3339Nano), value)
}

// point builds a Point at a run-relative offset from the test anchor.
func point(metric string, offsetMs int, value string) string {
	return pointAtTime(metric, testAnchor.Add(time.Duration(offsetMs)*time.Millisecond), value)
}

// pointRawTime builds a Point with an arbitrary (possibly corrupt) time string.
func pointRawTime(metric, ts, value string) string {
	return fmt.Sprintf(`{"type":"Point","metric":%q,"data":{"time":%q,"value":%s,"tags":{}}}`, metric, ts, value)
}

// pointNoTime builds a Point without data.time (arrival-time fallback input).
func pointNoTime(metric, value string) string {
	return fmt.Sprintf(`{"type":"Point","metric":%q,"data":{"value":%s,"tags":{}}}`, metric, value)
}

func feed(a *RunWindowAggregator, lines ...string) {
	for _, l := range lines {
		a.OnLine([]byte(l))
	}
}

// newTestAgg wires a fixed arrival-time clock (the fallback source).
func newTestAgg(sink FrameSink, now time.Time) *RunWindowAggregator {
	return newRunWindowAggregator("run-1", testAnchor, sink, func() time.Time { return now })
}

func TestFrameJSONMatchesContractFieldNames(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		`{"type":"Metric","metric":{"type":"Counter","name":"http_reqs","contains":"count"}}`,
		point("http_reqs", 100, "1"),
		point("http_req_duration", 100, "42.5"),
		point("http_req_failed", 100, "1"),
		point("vus", 100, "3"),
		point("http_reqs", 1100, "1"), // rolls window 0 out
	)
	frames := sink.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	got, err := frames[0].EncodeJSON()
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}
	want := `{"version":1,"type":"metrics","runId":"run-1","seq":0,` +
		`"window":{"startMs":0,"durationMs":1000},"reqPerSec":1,` +
		`"latencyMs":{"avg":42.5,"p90":42.5,"p95":42.5,"p99":42.5},` +
		`"httpFailureFraction":1,"activeVUs":3,"failedChecks":0}`
	if string(got) != want {
		t.Errorf("EncodeJSON =\n %s\nwant\n %s", got, want)
	}
}

func TestNoRequestWindowNullsSampleTrioTogether(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("vus", 0, "5"),
		point("checks", 50, "0"),
		point("http_req_duration", 80, "12"), // stray sample, no requests in window
		point("http_reqs", 1100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	f := frames[0]
	if f.ReqPerSec != nil || f.LatencyMs.Avg != nil || f.LatencyMs.P90 != nil ||
		f.LatencyMs.P95 != nil || f.LatencyMs.P99 != nil || f.HTTPFailureFraction != nil {
		t.Errorf("sample-derived trio must be null exactly together: rps=%v lat=%+v frac=%v",
			f.ReqPerSec, f.LatencyMs, f.HTTPFailureFraction)
	}
	if f.FailedChecks != 1 {
		t.Errorf("FailedChecks = %d, want 1 (never null, 0-vs-count)", f.FailedChecks)
	}
	if f.ActiveVUs != 5 {
		t.Errorf("ActiveVUs = %d, want 5", f.ActiveVUs)
	}
}

func TestWindowBoundariesAreHalfOpen(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("http_reqs", 999, "1"),
		point("http_reqs", 1000, "1"),
		point("http_reqs", 1999, "1"),
		point("http_reqs", 2000, "1"),
		point("http_reqs", 3000, "1"),
		point("http_reqs", 4000, "1"),
	)
	frames := sink.snapshot()
	want := []struct {
		startMs int64
		rps     float64
	}{{0, 1}, {1000, 2}, {2000, 1}, {3000, 1}}
	if len(frames) != len(want) {
		t.Fatalf("frames = %d, want %d", len(frames), len(want))
	}
	for i, w := range want {
		if frames[i].Window.StartMs != w.startMs {
			t.Errorf("frame %d startMs = %d, want %d", i, frames[i].Window.StartMs, w.startMs)
		}
		if frames[i].Window.DurationMs != 1000 {
			t.Errorf("frame %d durationMs = %d, want literal 1000", i, frames[i].Window.DurationMs)
		}
		if frames[i].ReqPerSec == nil || *frames[i].ReqPerSec != w.rps {
			t.Errorf("frame %d reqPerSec = %v, want %v", i, frames[i].ReqPerSec, w.rps)
		}
	}
}

func TestEmptyWindowsEmitWithCarriedGauge(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("vus", 100, "7"),
		point("http_reqs", 100, "1"),
		point("http_reqs", 3100, "1"), // gap: windows 1 and 2 have no points
	)
	frames := sink.snapshot()
	if len(frames) != 3 {
		t.Fatalf("frames = %d, want 3 (empty windows emit while run is active)", len(frames))
	}
	for i, f := range frames {
		if f.Seq != int64(i) || f.Window.StartMs != int64(i)*1000 {
			t.Errorf("frame %d: seq=%d startMs=%d, want seq=%d startMs=%d", i, f.Seq, f.Window.StartMs, i, i*1000)
		}
		if f.ActiveVUs != 7 {
			t.Errorf("frame %d ActiveVUs = %d, want carried gauge 7", i, f.ActiveVUs)
		}
		if f.FailedChecks != 0 {
			t.Errorf("frame %d FailedChecks = %d, want 0", i, f.FailedChecks)
		}
	}
	if frames[0].ReqPerSec == nil {
		t.Error("window 0 had a request; reqPerSec must be non-null")
	}
	for _, i := range []int{1, 2} {
		f := frames[i]
		if f.ReqPerSec != nil || f.LatencyMs.Avg != nil || f.HTTPFailureFraction != nil {
			t.Errorf("empty window %d must carry the null trio, got rps=%v", i, f.ReqPerSec)
		}
	}
}

func TestSeqIsMonotonicPerEmittedWindow(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	for i := 1; i <= 5; i++ {
		feed(a, point("http_reqs", i*1000, "1"))
	}
	frames := sink.snapshot()
	if len(frames) != 5 {
		t.Fatalf("frames = %d, want 5", len(frames))
	}
	for i, f := range frames {
		if f.Seq != int64(i) {
			t.Errorf("frame %d seq = %d, want %d (starts 0, +1 per window)", i, f.Seq, i)
		}
		if f.Version != 1 || f.Type != "metrics" || f.RunID != "run-1" {
			t.Errorf("frame %d envelope = v%d type=%q runId=%q", i, f.Version, f.Type, f.RunID)
		}
	}
}

func TestPerWindowValuesAreNotCumulative(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("http_reqs", 100, "1"),
		point("http_reqs", 200, "1"),
		point("http_reqs", 1100, "1"),
		point("http_reqs", 1200, "1"),
		point("http_reqs", 2100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	for i, f := range frames {
		if f.ReqPerSec == nil || *f.ReqPerSec != 2 {
			t.Errorf("frame %d reqPerSec = %v, want per-window 2 (never the cumulative 4)", i, f.ReqPerSec)
		}
	}
}

func TestFailureFractionIsPerWindowAndBounded(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("http_reqs", 100, "1"),
		point("http_req_failed", 150, "0"),
		point("http_reqs", 200, "1"),
		point("http_req_failed", 250, "1"),
		point("http_reqs", 1100, "1"),
		point("http_req_failed", 1150, "1"),
		point("http_reqs", 2100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(frames))
	}
	if v := frames[0].HTTPFailureFraction; v == nil || *v != 0.5 {
		t.Errorf("window 0 httpFailureFraction = %v, want 0.5", v)
	}
	if v := frames[1].HTTPFailureFraction; v == nil || *v != 1 {
		t.Errorf("window 1 httpFailureFraction = %v, want 1", v)
	}
	for i, f := range frames {
		if f.HTTPFailureFraction != nil && (*f.HTTPFailureFraction < 0 || *f.HTTPFailureFraction > 1) {
			t.Errorf("frame %d fraction %v outside [0,1]", i, *f.HTTPFailureFraction)
		}
	}
}

func TestFailedChecksCountsZeroValuedChecksAndLegacyName(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("checks", 100, "0"),
		point("checks", 150, "1"),
		point("check", 200, "0"), // legacy spelling still folds in
		point("http_reqs", 1100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	if frames[0].FailedChecks != 2 {
		t.Errorf("FailedChecks = %d, want 2", frames[0].FailedChecks)
	}
	enc, err := frames[0].EncodeJSON()
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}
	if !strings.Contains(string(enc), `"failedChecks":2`) {
		t.Errorf("failedChecks must serialize as a number, got %s", enc)
	}
}

func TestActiveVUsStartsAtZeroAndCarriesForward(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("http_reqs", 100, "1"),  // window 0: no vus point yet → 0
		point("http_reqs", 1100, "1"), // rollover → frame 0
		point("vus", 1200, "9"),       // window 1 update
		point("http_reqs", 2100, "1"), // rollover → frame 1 (gauge 9)
		point("http_reqs", 3100, "1"), // rollover → frame 2 (gauge 9)
	)
	frames := sink.snapshot()
	if len(frames) != 3 {
		t.Fatalf("frames = %d, want 3", len(frames))
	}
	if frames[0].ActiveVUs != 0 {
		t.Errorf("frame 0 ActiveVUs = %d, want initial 0 before any vus point", frames[0].ActiveVUs)
	}
	for i := 1; i < 3; i++ {
		if frames[i].ActiveVUs != 9 {
			t.Errorf("frame %d ActiveVUs = %d, want carried gauge 9", i, frames[i].ActiveVUs)
		}
	}
}

// TestLatencyAndTotalsParityWithK6sum proves the window math matches the
// frozen k6sum nearest-rank/rounding semantics on identical input.
func TestLatencyAndTotalsParityWithK6sum(t *testing.T) {
	var lines []string
	samples := []string{"10", "20", "30", "40", "50", "60", "70", "80", "90", "100"}
	for i, d := range samples {
		lines = append(lines, point("http_reqs", 10+i*10, "1"))
		lines = append(lines, point("http_req_duration", 10+i*10, d))
	}
	lines = append(lines,
		point("http_req_failed", 30, "1"),
		point("http_req_failed", 60, "1"),
		point("http_req_failed", 90, "0"),
		point("checks", 40, "0"),
		point("checks", 70, "1"),
		point("checks", 80, "0"),
	)
	summary, err := k6sum.Parse(strings.NewReader(strings.Join(lines, "\n") + "\n"))
	if err != nil {
		t.Fatalf("k6sum.Parse: %v", err)
	}
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a, lines...)
	feed(a, point("http_reqs", 1000, "1")) // rollover
	frames := sink.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	f := frames[0]
	if f.ReqPerSec == nil || *f.ReqPerSec != float64(summary.Totals.Requests) {
		t.Errorf("reqPerSec = %v, want k6sum requests %d", f.ReqPerSec, summary.Totals.Requests)
	}
	if f.FailedChecks != int(summary.Totals.FailedChecks) {
		t.Errorf("failedChecks = %d, want k6sum %d", f.FailedChecks, summary.Totals.FailedChecks)
	}
	if f.HTTPFailureFraction == nil || *f.HTTPFailureFraction != float64(summary.Totals.Errors)/float64(summary.Totals.Requests) {
		t.Errorf("fraction = %v, want k6sum errors/requests %d/%d", f.HTTPFailureFraction, summary.Totals.Errors, summary.Totals.Requests)
	}
	for name, pair := range map[string][2]float64{
		"avg": {must(f.LatencyMs.Avg), summary.LatencyMs.Avg},
		"p90": {must(f.LatencyMs.P90), summary.LatencyMs.P90},
		"p95": {must(f.LatencyMs.P95), summary.LatencyMs.P95},
		"p99": {must(f.LatencyMs.P99), summary.LatencyMs.P99},
	} {
		if pair[0] != pair[1] {
			t.Errorf("latency %s = %v, want k6sum %v (same nearest-rank math)", name, pair[0], pair[1])
		}
	}
}

func must(p *float64) float64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestMissingPointTimeFallsBackToArrivalTime(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor.Add(2500*time.Millisecond))
	feed(a, pointNoTime("http_reqs", "1")) // no time → arrival at +2500ms → window 2
	feed(a, point("http_reqs", 4000, "1")) // rollover → emits windows 0,1 (empty), 2,3 later
	feed(a, point("http_reqs", 5000, "1")) // emits window 3
	feed(a, point("http_reqs", 6000, "1")) // emits window 4
	feed(a, point("http_reqs", 7000, "1")) // emits window 5
	frames := sink.snapshot()
	if len(frames) != 7 {
		t.Fatalf("frames = %d, want 7", len(frames))
	}
	f := frames[2]
	if f.Window.StartMs != 2000 || f.ReqPerSec == nil || *f.ReqPerSec != 1 {
		t.Errorf("arrival-time frame = startMs %d rps %v, want window 2000 with 1 request", f.Window.StartMs, f.ReqPerSec)
	}
}

func TestPointBeforeAnchorClampsToFirstWindow(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		pointAtTime("http_reqs", testAnchor.Add(-500*time.Millisecond), "1"), // pre-anchor skew → window 0
		point("http_reqs", 1100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1 (no negative windows)", len(frames))
	}
	if frames[0].Window.StartMs != 0 || frames[0].ReqPerSec == nil || *frames[0].ReqPerSec != 1 {
		t.Errorf("frame = %+v, want startMs 0 with the pre-anchor request folded in", frames[0])
	}
}

func TestCorruptFuturePointTimeFallsBackToArrivalTime(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor.Add(3*time.Second))
	feed(a,
		pointRawTime("http_reqs", testAnchor.Add(2*time.Hour).Format(time.RFC3339Nano), "1"), // corrupt → arrival +3s → window 3
		point("http_reqs", 5000, "1"),
		point("http_reqs", 6000, "1"),
		point("http_reqs", 7000, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 7 {
		t.Fatalf("frames = %d, want 7 (skew guard prevents a 2-hour frame flood)", len(frames))
	}
	for _, f := range frames {
		if f.Window.StartMs > 6000 {
			t.Fatalf("frame startMs %d exceeds the guard; corrupt time must not fan out windows", f.Window.StartMs)
		}
	}
	if rps := frames[3].ReqPerSec; rps == nil || *rps != 1 {
		t.Errorf("window 3 reqPerSec = %v, want 1 (corrupt point landed by arrival time)", rps)
	}
}

// TestMalformedLinesAreIgnoredWhileK6sumFails documents the deliberate
// policy divergence: broadcast is best-effort, the summary is fail-the-summary.
func TestMalformedLinesAreIgnoredWhileK6sumFails(t *testing.T) {
	garbage := []string{
		"this is not json-lines",
		`{"type":"Point","metric":123,"data":{"value":1}}`,
		`{"type":"Point","metric":"http_reqs","data":{"value":"x"}}`,
		`{"type":"Point","metric":"vm_iterations","data":{"value":1}}`,
		`{"type":"Summary","data":{}}`,
		"",
	}
	input := strings.Join(append(append([]string{}, garbage...), point("http_reqs", 100, "1"), point("http_reqs", 1100, "1")), "\n") + "\n"
	if _, err := k6sum.Parse(strings.NewReader(input)); err == nil {
		t.Fatal("k6sum.Parse error = nil, want fail-the-summary on the same input")
	}
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	for _, l := range strings.Split(input, "\n") {
		a.OnLine([]byte(l))
	}
	frames := sink.snapshot()
	if len(frames) != 1 || frames[0].ReqPerSec == nil || *frames[0].ReqPerSec != 1 {
		t.Fatalf("aggregator frames = %+v, want 1 frame with 1 request despite malformed neighbors", frames)
	}
}

// TestOversizedLineSkippedWhileK6sumFails documents the 1 MiB guard
// (k6sum.MaxLineBytes) on the broadcast path: skip, never buffer.
func TestOversizedLineSkippedWhileK6sumFails(t *testing.T) {
	big := strings.Repeat("x", k6sum.MaxLineBytes+1)
	input := big + "\n" + point("http_reqs", 100, "1") + "\n" + point("http_reqs", 1100, "1") + "\n"
	if _, err := k6sum.Parse(strings.NewReader(input)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("k6sum.Parse error = %v, want oversized-line rejection", err)
	}
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	a.OnLine([]byte(big))
	feed(a, point("http_reqs", 100, "1"), point("http_reqs", 1100, "1"))
	frames := sink.snapshot()
	if len(frames) != 1 || frames[0].ReqPerSec == nil || *frames[0].ReqPerSec != 1 {
		t.Fatalf("frames = %+v, want aggregator to skip the oversized line and continue", frames)
	}
}

func TestLateOutOfOrderPointIsDropped(t *testing.T) {
	sink := &recordingSink{}
	a := newTestAgg(sink, testAnchor)
	feed(a,
		point("http_reqs", 100, "1"),
		point("http_reqs", 5100, "1"), // rolls out windows 0..4, collecting in 5
		point("http_reqs", 1100, "1"), // late point for an already-emitted window → dropped
		point("http_reqs", 6100, "1"),
		point("http_reqs", 7100, "1"),
	)
	frames := sink.snapshot()
	if len(frames) != 7 {
		t.Fatalf("frames = %d, want 7", len(frames))
	}
	if rps := frames[5].ReqPerSec; rps == nil || *rps != 1 {
		t.Errorf("window 5 reqPerSec = %v, want 1 (late point must not double-count)", rps)
	}
}

func TestNilSinkAndEmptyStreamAreSafe(t *testing.T) {
	a := NewRunWindowAggregator("run-1", testAnchor, nil)
	feed(a, point("http_reqs", 100, "1"), point("http_reqs", 1100, "1"))
	a.OnLine(nil)
	a.OnLine([]byte("   "))
	a.OnLine([]byte("{"))
	sink := &recordingSink{}
	b := newTestAgg(sink, testAnchor)
	feed(b, `{"type":"Summary","data":{}}`)
	if got := sink.snapshot(); len(got) != 0 {
		t.Errorf("frames = %d, want 0 for a stream without points", len(got))
	}
}
