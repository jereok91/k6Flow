// K6F3-04 — pure live-metrics logic for the minimal dashboard (no I/O, no deps).
//
// Hand-rolled validation of the 10 contract fields (human-approved decision:
// ZERO new dependencies — `@k6flow/shared` is NOT imported, so apps/web keeps
// its dependency surface untouched). Textual-parity source of truth:
// `packages/shared/src/metrics-messages.ts` → `metricsFrameSchema` (read for
// reference only). Field names, literal values and nullability rules are
// mirrored 1:1 and pinned by `live-metrics.test.ts`.

export const SUBPROTOCOL = "k6flow.bearer";

/** Exact top-level key set of the contract frame (source: packages/shared/src/metrics-messages.ts). */
export const METRICS_FRAME_KEYS = [
  "version",
  "type",
  "runId",
  "seq",
  "window",
  "reqPerSec",
  "latencyMs",
  "httpFailureFraction",
  "activeVUs",
  "failedChecks",
] as const;

const WINDOW_KEYS = ["startMs", "durationMs"] as const;
const LATENCY_KEYS = ["avg", "p90", "p95", "p99"] as const;

export interface MetricsWindow {
  startMs: number;
  durationMs: number;
}

export interface LiveLatency {
  avg: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface LiveFrame {
  version: 1;
  type: "metrics";
  runId: string;
  seq: number;
  window: MetricsWindow;
  reqPerSec: number | null;
  latencyMs: LiveLatency;
  httpFailureFraction: number | null;
  activeVUs: number;
  failedChecks: number;
}

export type FrameValidation = { ok: true; frame: LiveFrame } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Contract: `z.number().int().nonnegative()` — zod's `.int()` is Number.isSafeInteger.
const isNonnegSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Sample-derived: finite nonnegative number or explicit null (never a silent 0).
const isSample = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

const isFailureFraction = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);

// Mirrors z.strictObject: unknown keys are rejected, so length equality is enough.
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
};

/**
 * Validates a parsed JSON value against the 10-field metrics contract and
 * returns a normalized frame or a rejection reason. Never throws.
 */
export function validateMetricsFrame(input: unknown): FrameValidation {
  if (!isRecord(input)) return { ok: false, reason: "frame is not an object" };
  if (!exactKeys(input, METRICS_FRAME_KEYS)) return { ok: false, reason: "unexpected top-level keys" };
  if (input.version !== 1) return { ok: false, reason: "version must be 1" };
  if (input.type !== "metrics") return { ok: false, reason: 'type must be "metrics"' };
  if (typeof input.runId !== "string" || input.runId.trim().length === 0)
    return { ok: false, reason: "runId must be a nonblank string" };
  if (!isNonnegSafeInt(input.seq)) return { ok: false, reason: "seq must be a nonnegative safe integer" };

  const window = input.window;
  if (!isRecord(window) || !exactKeys(window, WINDOW_KEYS))
    return { ok: false, reason: "window must have exactly startMs and durationMs" };
  if (window.durationMs !== 1000) return { ok: false, reason: "window.durationMs must be 1000" };
  if (!isNonnegSafeInt(window.startMs))
    return { ok: false, reason: "window.startMs must be a nonnegative safe integer" };

  if (!isSample(input.reqPerSec)) return { ok: false, reason: "reqPerSec must be a nonnegative number or null" };

  const latency = input.latencyMs;
  if (!isRecord(latency) || !exactKeys(latency, LATENCY_KEYS))
    return { ok: false, reason: "latencyMs must have exactly avg, p90, p95, p99" };
  for (const key of LATENCY_KEYS) {
    if (!isSample(latency[key])) return { ok: false, reason: `latencyMs.${key} must be a nonnegative number or null` };
  }

  if (!isFailureFraction(input.httpFailureFraction))
    return { ok: false, reason: "httpFailureFraction must be within [0,1] or null" };
  if (!isNonnegSafeInt(input.activeVUs)) return { ok: false, reason: "activeVUs must be a nonnegative safe integer" };
  if (!isNonnegSafeInt(input.failedChecks)) return { ok: false, reason: "failedChecks must be a nonnegative safe integer" };

  // Sample-derived trio (reqPerSec, 4 latencies, failure fraction) is null EXACTLY together.
  const samples = [
    input.reqPerSec,
    latency.avg,
    latency.p90,
    latency.p95,
    latency.p99,
    input.httpFailureFraction,
  ];
  if (samples.some((value) => value === null) && !samples.every((value) => value === null))
    return { ok: false, reason: "sample-derived metrics must be null exactly together" };

  return { ok: true, frame: input as unknown as LiveFrame };
}

export interface WindowList {
  frames: LiveFrame[]; // last `max` accepted frames (default 60)
  rejected: number; // invalid frames, exposed as a UI counter
  outOfOrder: boolean; // sticky: a seq regressed or duplicated (flagged, never thrown)
  seqGaps: number; // forward seq jumps (legal under drop-oldest backpressure)
}

export const emptyWindowList = (): WindowList => ({
  frames: [],
  rejected: 0,
  outOfOrder: false,
  seqGaps: 0,
});

/** Validates before appending, keeps the last `max` windows, flags seq anomalies without crashing. */
export function appendWindow(list: WindowList, input: unknown, max = 60): WindowList {
  const result = validateMetricsFrame(input);
  if (!result.ok) return { ...list, rejected: list.rejected + 1 };

  const last = list.frames[list.frames.length - 1];
  let outOfOrder = list.outOfOrder;
  let seqGaps = list.seqGaps;
  if (last) {
    if (result.frame.seq <= last.seq) outOfOrder = true;
    else if (result.frame.seq > last.seq + 1) seqGaps += 1;
  }
  const frames = [...list.frames, result.frame];
  if (frames.length > max) frames.splice(0, frames.length - max);
  return { frames, rejected: list.rejected, outOfOrder, seqGaps };
}

/** Same-origin contract-05 URL: origin (scheme included) → ws(s)://<origin>/api/ws/runs/<id>. */
export function buildWsUrl(origin: string, runId: string): string {
  const base = origin.replace(/\/+$/, "").replace(/^http/, "ws"); // http→ws, https→wss
  return `${base}/api/ws/runs/${encodeURIComponent(runId)}`;
}

/** Browser handshake: token travels in Sec-WebSocket-Protocol, never in the URL. */
export function wsProtocols(token: string): string[] {
  return [SUBPROTOCOL, token];
}

export const EMPTY_CELL = "—";

/** Null → em dash; otherwise one decimal (JS Number.toFixed rounding). */
export function formatRate(value: number | null): string {
  return value === null ? EMPTY_CELL : value.toFixed(1);
}

/** Null → em dash; otherwise fixed integer milliseconds. */
export function formatLatency(value: number | null): string {
  return value === null ? EMPTY_CELL : value.toFixed(0);
}

/** Null → em dash; otherwise fraction → percent with one decimal, e.g. 0.025 → "2.5%". */
export function formatFailurePercent(value: number | null): string {
  return value === null ? EMPTY_CELL : `${(value * 100).toFixed(1)}%`;
}
