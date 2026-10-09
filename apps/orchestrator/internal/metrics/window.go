// Package metrics aggregates the k6 `--out json` JSON-LINES point stream into
// fixed 1-second, run-relative window frames implementing the Phase 1 metrics
// WebSocket contract (docs/api/ws-metrics.md; the frame shape, units and
// nullability are fixed by packages/shared/src/metrics-messages.ts and are
// implemented here, never reinterpreted).
//
// The aggregator is pure in the I/O sense: it performs no I/O, spawns no
// goroutines and is fed line-by-line on a single goroutine by the engine's
// Output() tap. Documented policy (full rationale in docs/DECISIONES.md,
// K6F3-01):
//
//   - Windows are half-open [n·1000ms, (n+1)·1000ms) intervals anchored at
//     the tap start (the anchor is injected; k6 point times, data.time, map to
//     run-relative offsets from it). A point without a usable time falls back
//     to arrival time — accurate only while the stream is read live, since a
//     buffered read compresses arrival times toward the anchor. Points stamped
//     before the anchor (container clock skew; k6 may emit before the tap
//     attaches) clamp into window 0; points more than maxForwardSkew ahead of
//     the anchor are treated as corrupt and also use arrival time, so a bogus
//     timestamp can never fan out a flood of windows.
//   - Values are per-window: a frame never carries cumulative totals. The
//     sample trio (reqPerSec, the four latencies, httpFailureFraction) is
//     null exactly together, iff the window had no http_reqs points;
//     activeVUs (gauge, initial 0, carried forward) and failedChecks are
//     never null.
//   - Malformed, unknown-type, unknown-metric, undecodable-value and
//     oversized (> k6sum.MaxLineBytes) lines are ignored. This deliberately
//     diverges from k6sum's fail-the-summary policy: the broadcast path is
//     best-effort and must never kill a run.
//   - Frames are emitted only on window rollover: every window that closes
//     while the stream is active emits exactly one frame (no-request windows
//     included), seq starts at 0 and increases by 1 per emitted window, and
//     the trailing partial window never emits (no end-of-stream flush).
//   - Memory is bounded: at most one window's samples are retained; they are
//     discarded when its frame is emitted.
package metrics

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"time"

	"k6flow/apps/orchestrator/internal/k6sum"
)

const (
	// contractVersion and frameType are the Phase 1 envelope literals
	// (versionEnvelopeSchema / the closed "metrics" union discriminator).
	contractVersion = 1
	frameType       = "metrics"
	// windowMillis is the fixed window width (window.durationMs literal).
	windowMillis int64 = 1000
	// windowSeconds is the fixed denominator of reqPerSec (window count / 1 s).
	windowSeconds = 1.0
	// metricVUs is the k6 active-VUs gauge metric (not part of k6sum's
	// summary catalog, hence not exported by the frozen package).
	metricVUs = "vus"
	// maxForwardSkew bounds sane point times: a stamp further than this ahead
	// of the anchor is treated as clock-corrupt and falls back to arrival time.
	maxForwardSkew = time.Hour
	// maxSafeInteger mirrors the contract's nonnegative safe-integer ceiling.
	maxSafeInteger = float64(1<<53 - 1)
)

// Window is the contract's fixed 1000 ms window declaration with a
// run-relative start.
type Window struct {
	StartMs    int64 `json:"startMs"`
	DurationMs int64 `json:"durationMs"`
}

// LatencyMs holds the four sample-derived latencies; a nil pointer
// serializes as JSON null (no-request window).
type LatencyMs struct {
	Avg *float64 `json:"avg"`
	P90 *float64 `json:"p90"`
	P95 *float64 `json:"p95"`
	P99 *float64 `json:"p99"`
}

// MetricsFrame is the wire frame declared by metrics-messages.ts. Field
// names, literals and nullability are contract-fixed; activeVUs and
// failedChecks are plain integers so they can never serialize as null.
type MetricsFrame struct {
	Version             int       `json:"version"`
	Type                string    `json:"type"`
	RunID               string    `json:"runId"`
	Seq                 int64     `json:"seq"`
	Window              Window    `json:"window"`
	ReqPerSec           *float64  `json:"reqPerSec"`
	LatencyMs           LatencyMs `json:"latencyMs"`
	HTTPFailureFraction *float64  `json:"httpFailureFraction"`
	ActiveVUs           int       `json:"activeVUs"`
	FailedChecks        int       `json:"failedChecks"`
}

// EncodeJSON serializes the frame with exactly the contract field names
// (compact form, no trailing newline — one WS message payload).
func (f MetricsFrame) EncodeJSON() ([]byte, error) {
	return json.Marshal(f)
}

// FrameSink is the injection point for downstream consumers (the K6F3-02
// hub; nil means no sink). OnFrame is called synchronously on the tap's
// single goroutine, never concurrently for one run; implementations own
// their own buffering/backpressure. A panicking sink is recovered and logged
// by the engine tap and never fails the run.
type FrameSink interface {
	OnFrame(frame MetricsFrame)
}

// windowBucket accumulates one window's samples. It is reset when the
// window's frame is emitted (samples never outlive their window); only the
// VU gauge carries forward.
type windowBucket struct {
	requests     int
	failSum      float64
	durations    []float64
	failedChecks int
	activeVUs    int
}

// RunWindowAggregator is the per-run window state machine. Not safe for
// concurrent use: feed it from a single goroutine (the engine tap).
type RunWindowAggregator struct {
	runID     string
	anchor    time.Time
	sink      FrameSink
	now       func() time.Time  // arrival-time fallback clock (test seam)
	endpoints *EndpointsTracker // optional per-endpoint tracking

	seq    int64 // next seq to assign (0-based, +1 per emitted window)
	winIdx int64 // window currently collecting
	bucket windowBucket
}

// NewRunWindowAggregator builds the aggregator for one run: runID labels the
// frames, anchor is the tap-start time that defines run-relative window 0,
// sink receives frames (nil disables emission).
func NewRunWindowAggregator(runID string, anchor time.Time, sink FrameSink) *RunWindowAggregator {
	return newRunWindowAggregator(runID, anchor, sink, time.Now)
}

// newRunWindowAggregator injects the arrival-time clock for tests.
func newRunWindowAggregator(runID string, anchor time.Time, sink FrameSink, now func() time.Time) *RunWindowAggregator {
	if now == nil {
		now = time.Now
	}
	return &RunWindowAggregator{runID: runID, anchor: anchor, sink: sink, now: now}
}

// SetEndpointsTracker sets the optional per-endpoint tracker.
func (a *RunWindowAggregator) SetEndpointsTracker(t *EndpointsTracker) {
	a.endpoints = t
}

// GetEndpointsTracker returns the per-endpoint tracker (may be nil).
func (a *RunWindowAggregator) GetEndpointsTracker() *EndpointsTracker {
	return a.endpoints
}

// OnLine folds one raw JSON-LINES line (newline optional, trailing whitespace
// tolerated). Defensive by design: blank, malformed, non-Point, unknown
// metric, undecodable-value and oversized (> k6sum.MaxLineBytes) lines are
// ignored without error, and late points for already-emitted windows are
// dropped. The line bytes are not retained beyond the call. OnLine itself
// does not panic; a panicking FrameSink surfaces here and is isolated by the
// caller (the engine tap).
func (a *RunWindowAggregator) OnLine(line []byte) {
	if len(line) > k6sum.MaxLineBytes {
		return
	}
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	var msg struct {
		Type   string          `json:"type"`
		Metric json.RawMessage `json:"metric"`
		Data   json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		return
	}
	if msg.Type != "Point" {
		return // Metric descriptors, Summary, Group and future types carry no point
	}
	var name string
	if err := json.Unmarshal(msg.Metric, &name); err != nil || !knownMetric(name) {
		return
	}
	var data struct {
		Time  *string  `json:"time"`
		Value *float64 `json:"value"`
		Tags  *struct {
			Method    string `json:"method"`
			URL       string `json:"url"`
			Name      string `json:"name"`
			Status    string `json:"status"`
			Error     string `json:"error"`
			ErrorCode string `json:"error_code"`
		} `json:"tags"`
	}
	if err := json.Unmarshal(msg.Data, &data); err != nil || data.Value == nil {
		return
	}
	// Per-endpoint metrics are cumulative (not windowed), so they are recorded
	// before the late-point drop below: a late point still counts for its endpoint.
	if a.endpoints != nil && data.Tags != nil && data.Tags.URL != "" {
		tg := data.Tags
		a.recordEndpoint(name, *data.Value, tg.Method, tg.URL, tg.Name, tg.Status, tg.ErrorCode, tg.Error, a.pointTimeMs(data.Time))
	}
	idx := int64(a.offset(data.Time).Milliseconds()) / windowMillis
	if idx > a.winIdx {
		// Rollover: emit every window that closed (including no-request
		// gaps), then start collecting idx. emit resets the bucket itself.
		for i := a.winIdx; i < idx; i++ {
			a.emit(i)
		}
		a.winIdx = idx
	} else if idx < a.winIdx {
		return // late/out-of-order point for an already-emitted window
	}
	a.fold(name, *data.Value)
}

// pointTimeMs returns the point's data.time in ms since epoch, falling back to
// the arrival clock when the time is absent or unparsable.
func (a *RunWindowAggregator) pointTimeMs(ts *string) int64 {
	if ts != nil {
		if pt, err := time.Parse(time.RFC3339Nano, *ts); err == nil {
			return pt.UnixMilli()
		}
	}
	return a.now().UnixMilli()
}

// knownMetric reports whether the point feeds any frame field; everything
// else (like in k6sum) is ignored defensively.
func knownMetric(name string) bool {
	switch name {
	case k6sum.MetricRequests, k6sum.MetricFailed, k6sum.MetricCheck,
		k6sum.MetricCheckLegacy, k6sum.MetricDurationMs, metricVUs:
		return true
	}
	return false
}

// offset maps a point's data.time to a nonnegative run-relative offset from
// the anchor, applying the documented fallbacks (see package doc).
func (a *RunWindowAggregator) offset(ts *string) time.Duration {
	arrival := func() time.Duration {
		if d := a.now().Sub(a.anchor); d > 0 {
			return d
		}
		return 0
	}
	if ts == nil {
		return arrival()
	}
	pt, err := time.Parse(time.RFC3339Nano, *ts)
	if err != nil {
		return arrival()
	}
	off := pt.Sub(a.anchor)
	if off < 0 {
		return 0 // pre-anchor point: clamped into window 0
	}
	if off > maxForwardSkew {
		return arrival() // corrupt/clock-skewed future stamp: anti-flood guard
	}
	return off
}

// fold accumulates one point into the current window bucket by metric,
// mirroring k6sum's semantics (http_reqs counted per point — one k6 counter
// point per request — and 0/1 rate sums).
func (a *RunWindowAggregator) fold(name string, value float64) {
	switch name {
	case k6sum.MetricRequests:
		a.bucket.requests++
	case k6sum.MetricFailed:
		a.bucket.failSum += value
	case k6sum.MetricCheck, k6sum.MetricCheckLegacy:
		if value == 0 {
			a.bucket.failedChecks++
		}
	case k6sum.MetricDurationMs:
		a.bucket.durations = append(a.bucket.durations, value)
	case metricVUs:
		v := math.Round(value)
		if v < 0 {
			v = 0
		}
		if v > maxSafeInteger {
			v = maxSafeInteger
		}
		a.bucket.activeVUs = int(v) // gauge: last value seen for this window
	}
}

// recordEndpoint feeds the per-endpoint tracker. k6 emits exactly one
// http_req_duration point per request (failed or not) and one http_req_failed
// point (0/1) per request, so requests are counted from the former and
// failures from the latter (value 1) — http_reqs is ignored to avoid double
// counting. Status "0"/empty/unparsable means a network error (no response).
func (a *RunWindowAggregator) recordEndpoint(metric string, value float64, method, url, name, status, errorCode, errorMsg string, tsMs int64) {
	if a.endpoints == nil {
		return
	}
	switch metric {
	case k6sum.MetricDurationMs:
		a.endpoints.RecordRequest(method, url, name, value)
	case k6sum.MetricFailed:
		if value > 0 {
			statusInt, err := strconv.Atoi(status)
			if err != nil || statusInt < 0 {
				statusInt = 0
			}
			a.endpoints.RecordFailure(method, url, name, statusInt, errorCode, errorMsg, 0, tsMs)
		}
	}
}

// emit renders window idx from the current bucket, resets the bucket
// (discarding its samples; the VU gauge carries forward), advances seq and
// delivers the frame to the sink (nil sink = emission is a no-op).
func (a *RunWindowAggregator) emit(idx int64) {
	b := a.bucket
	frame := MetricsFrame{
		Version:      contractVersion,
		Type:         frameType,
		RunID:        a.runID,
		Seq:          a.seq,
		Window:       Window{StartMs: idx * windowMillis, DurationMs: windowMillis},
		ActiveVUs:    b.activeVUs,
		FailedChecks: b.failedChecks,
	}
	if b.requests > 0 {
		// Sample-derived trio: present exactly when the window had requests.
		rps := float64(b.requests) / windowSeconds
		frac := round3(clamp01(b.failSum / float64(b.requests)))
		frame.ReqPerSec = &rps
		frame.HTTPFailureFraction = &frac
		frame.LatencyMs = windowLatency(b.durations)
	}
	a.bucket = windowBucket{activeVUs: b.activeVUs}
	a.seq++
	if a.sink != nil {
		a.sink.OnFrame(frame)
	}
}

// windowLatency replicates k6sum's latencyOf/percentile/round3 (those
// helpers are unexported in the frozen k6sum package) so window frames and
// the final summary agree bit-for-bit — a parity test proves it on identical
// input. Zero samples with requests > 0 yields zeros: the contract refine
// requires the trio non-null whenever reqPerSec is non-null, and real k6
// pairs one duration point per request. A 3-decimal (0.001 ms) rounding
// matches the Phase 2 summary choice; the schema enforces ranges only.
func windowLatency(samples []float64) LatencyMs {
	if len(samples) == 0 {
		z1, z2, z3, z4 := 0.0, 0.0, 0.0, 0.0
		return LatencyMs{Avg: &z1, P90: &z2, P95: &z3, P99: &z4}
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	return LatencyMs{
		Avg: ptr(roundNonneg(sum / float64(len(sorted)))),
		P90: ptr(roundNonneg(percentile(sorted, 90))),
		P95: ptr(roundNonneg(percentile(sorted, 95))),
		P99: ptr(roundNonneg(percentile(sorted, 99))),
	}
}

func ptr(v float64) *float64 { return &v }

// percentile is k6sum's nearest-rank quantile, replicated verbatim: rank =
// ceil(p/100 · n) clamped to [1, n], no interpolation.
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

// round3 is k6sum's 3-decimal rounding (half away from zero), replicated;
// roundNonneg additionally clamps to the contract's nonnegative range.
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func roundNonneg(v float64) float64 {
	if v < 0 {
		return 0
	}
	return round3(v)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
