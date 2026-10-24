// Pure mapping from a metrics frame to the RunExecutionPanel state.
//
// The frame arrives by two paths: the WebSocket (`tick` wrapping a frame, and
// the legacy bare `metrics` message) and, when the socket is unavailable, the
// polling fallback that fetches the latest frame over REST
// (`/api/orchestrator/runs/{runId}/metrics`). Both feed these helpers so the
// two paths cannot diverge.
//
// Behaviour is the panel's historical mapping, kept verbatim: a value absent
// from the frame (`null` for a no-request window, or a missing field) keeps the
// previous panel value, while the chart series always append one point, using 0
// for absent values.

/** Panel values a metrics frame writes; every other field is preserved. */
export interface PanelMetricValues {
  vus: number;
  requestRate: number;
  avgDuration: number;
  p95Duration: number;
  errorRate: number;
}

/** Chart series the panel accumulates one point per frame. */
export interface PanelChartSeries {
  time: number[];
  rps: number[];
  avgLatency: number[];
  p95Latency: number[];
  p99Latency: number[];
  vus: number[];
  errorRate: number[];
}

// Frame subset actually read: fields are optional and sample-derived values are
// null in a no-request window, exactly as the shared contract allows.
export interface MetricsFrameInput {
  // Window identity: the panel applies each window once (the polling fallback
  // can re-read the window the socket already delivered). Not mapped here.
  seq?: number | null;
  window?: { startMs?: number | null } | null;
  reqPerSec?: number | null;
  latencyMs?: { avg?: number | null; p95?: number | null; p99?: number | null } | null;
  httpFailureFraction?: number | null;
  activeVUs?: number | null;
}

/** Window start in seconds; the chart's x axis (a missing window is 0). */
export function frameWindowStartSec(frame: MetricsFrameInput): number {
  return (frame.window?.startMs ?? 0) / 1000;
}

/** Panel values after one frame; absent fields keep the previous value. */
export function applyFrameToMetrics<M extends PanelMetricValues>(prev: M, frame: MetricsFrameInput): M {
  return {
    ...prev,
    vus: frame.activeVUs ?? prev.vus,
    requestRate: frame.reqPerSec ?? prev.requestRate,
    avgDuration: frame.latencyMs?.avg ?? prev.avgDuration,
    p95Duration: frame.latencyMs?.p95 ?? prev.p95Duration,
    errorRate: frame.httpFailureFraction ?? prev.errorRate,
  };
}

/** Chart series after one frame; every series appends exactly one point. */
export function appendFrameToChart(prev: PanelChartSeries, frame: MetricsFrameInput): PanelChartSeries {
  return {
    time: [...prev.time, frameWindowStartSec(frame)],
    rps: [...prev.rps, frame.reqPerSec ?? 0],
    avgLatency: [...prev.avgLatency, frame.latencyMs?.avg ?? 0],
    p95Latency: [...prev.p95Latency, frame.latencyMs?.p95 ?? 0],
    p99Latency: [...prev.p99Latency, frame.latencyMs?.p99 ?? 0],
    vus: [...prev.vus, frame.activeVUs ?? 0],
    errorRate: [...prev.errorRate, frame.httpFailureFraction ?? 0],
  };
}
