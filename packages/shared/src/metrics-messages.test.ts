import { describe, expect, it } from "vitest";
import * as shared from "./index";
import {
  metricsFrameSchema, metricsLatencySchema, metricsWindowSchema,
} from "./metrics-messages";
// The workspace ships no @types/node; a widened specifier skips static type resolution.
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const max = Number.MAX_SAFE_INTEGER;
const invalidSafeInteger = [undefined, -1, 0.5, max + 1, NaN, Infinity, -Infinity, "0", null];
const invalidSampleValue = [undefined, -1, -0.001, NaN, Infinity, -Infinity, "0"];
const sample = { reqPerSec: 12.5, latencyMs: { avg: 1.5, p90: 12, p95: 20.5, p99: 80 },
  httpFailureFraction: 0 };
const noSample = { reqPerSec: null, latencyMs: { avg: null, p90: null, p95: null, p99: null },
  httpFailureFraction: null };
const frame: shared.MetricsFrame = {
  version: 1, type: "metrics", runId: "run-1", seq: 0,
  window: { startMs: 0, durationMs: 1000 }, activeVUs: 4, failedChecks: 1, ...sample,
};

describe("versioned metrics WebSocket frame declarations", () => {
  it("accepts an approved sampled metrics frame", () => {
    expect(metricsFrameSchema.parse(frame)).toEqual(frame);
  });

  it.each([undefined, 0, 2, "1"])("rejects version %j other than the literal 1", (version) => {
    expect(metricsFrameSchema.safeParse({ ...frame, version }).success).toBe(false);
  });

  it.each([undefined, "terminal", "error", "summary", "metrics ", 1])(
    'rejects frame type %j outside the closed "metrics" union', (type) => {
      expect(metricsFrameSchema.safeParse({ ...frame, type }).success).toBe(false);
    });

  it("declares exactly one frame variant and no terminal or error frame", () => {
    expect(metricsFrameSchema.options).toHaveLength(1);
    expect(metricsFrameSchema.safeParse({ ...frame, type: "reconnect" }).success).toBe(false);
  });

  it.each(["version", "type", "runId", "seq", "window", "reqPerSec", "latencyMs",
    "httpFailureFraction", "activeVUs", "failedChecks"])(
    "requires frame field %s", (field) => {
      const body: Record<string, unknown> = { ...frame };
      delete body[field];
      expect(metricsFrameSchema.safeParse(body).success).toBe(false);
      expect(metricsFrameSchema.safeParse({ ...frame, [field]: undefined }).success).toBe(false);
    });

  it("rejects unknown fields at every object level", () => {
    expect(metricsFrameSchema.safeParse({ ...frame, extra: true }).success).toBe(false);
    expect(metricsFrameSchema.safeParse({ ...frame, window: { ...frame.window, offsetMs: 0 } }).success).toBe(false);
    expect(metricsFrameSchema.safeParse({ ...frame, latencyMs: { ...frame.latencyMs, p50: 1 } }).success).toBe(false);
  });

  it.each([999, 1001, 2000, 0, "1000", 1000.5, null, undefined])(
    "rejects window duration %j other than the fixed 1000 ms window", (durationMs) => {
      expect(metricsWindowSchema.safeParse({ startMs: 0, durationMs }).success).toBe(false);
      expect(metricsFrameSchema.safeParse({ ...frame, window: { startMs: 0, durationMs } }).success).toBe(false);
    });

  it("accepts approved window boundaries", () => {
    expect(metricsWindowSchema.parse({ startMs: 0, durationMs: 1000 })).toEqual({ startMs: 0, durationMs: 1000 });
    expect(metricsWindowSchema.parse({ startMs: max, durationMs: 1000 }).startMs).toBe(max);
  });

  it.each(invalidSafeInteger)("rejects unsafe or nonnumeric run-relative start %j", (startMs) => {
    expect(metricsFrameSchema.safeParse({ ...frame, window: { startMs, durationMs: 1000 } }).success).toBe(false);
  });

  it.each(["", "   ", 1, null, undefined, []])("rejects nonopaque run identity %j", (runId) => {
    expect(metricsFrameSchema.safeParse({ ...frame, runId }).success).toBe(false);
  });

  it("accepts nonblank opaque run identifiers", () => {
    for (const runId of ["run-1", "  spaced  ", "run-✓-2"]) {
      expect(metricsFrameSchema.parse({ ...frame, runId }).runId).toBe(runId);
    }
  });

  it.each(invalidSafeInteger)("rejects unsafe or nonnumeric sequence %j", (seq) => {
    expect(metricsFrameSchema.safeParse({ ...frame, seq }).success).toBe(false);
  });

  it("accepts nonnegative sequence boundaries", () => {
    for (const seq of [0, 1, max]) expect(metricsFrameSchema.parse({ ...frame, seq }).seq).toBe(seq);
  });

  it.each([0, 0.5, 1, max])("accepts finite nonnegative request rate %j", (reqPerSec) => {
    expect(metricsFrameSchema.parse({ ...frame, reqPerSec }).reqPerSec).toBe(reqPerSec);
  });

  it.each(invalidSampleValue)("rejects invalid request rate %j", (reqPerSec) => {
    expect(metricsFrameSchema.safeParse({ ...frame, reqPerSec }).success).toBe(false);
  });

  it.each(["avg", "p90", "p95", "p99"])("rejects invalid latency value for percentile %s", (percentile) => {
    for (const value of invalidSampleValue) {
      expect(metricsFrameSchema.safeParse({ ...frame,
        latencyMs: { ...frame.latencyMs, [percentile]: value } }).success).toBe(false);
    }
  });

  it("accepts latency percentile boundaries including fractional milliseconds", () => {
    const latencyMs = { avg: 0, p90: 0.25, p95: 1, p99: max };
    expect(metricsLatencySchema.parse(latencyMs)).toEqual(latencyMs);
    expect(metricsFrameSchema.parse({ ...frame, latencyMs }).latencyMs).toEqual(latencyMs);
  });

  it.each([0, 0.25, 1])("accepts HTTP failure fraction boundary %j", (httpFailureFraction) => {
    expect(metricsFrameSchema.parse({ ...frame, httpFailureFraction }).httpFailureFraction)
      .toBe(httpFailureFraction);
  });

  it.each([1.0001, -0.001, 2, -1, NaN, Infinity, -Infinity, "0.5", undefined])(
    "rejects HTTP failure fraction %j outside [0,1] or nonnumeric", (httpFailureFraction) => {
      expect(metricsFrameSchema.safeParse({ ...frame, httpFailureFraction }).success).toBe(false);
    });

  it("accepts nonnegative safe-integer counters including zero", () => {
    for (const field of ["activeVUs", "failedChecks"] as const) {
      for (const value of [0, 1, max]) {
        expect(metricsFrameSchema.parse({ ...frame, [field]: value })[field]).toBe(value);
      }
    }
  });

  it.each(invalidSafeInteger)("rejects unsafe, nonnumeric or null counters %j", (value) => {
    for (const field of ["activeVUs", "failedChecks"]) {
      expect(metricsFrameSchema.safeParse({ ...frame, [field]: value }).success).toBe(false);
    }
  });

  it("accepts explicit no-sample windows while counts stay counts", () => {
    for (const counts of [{ activeVUs: 0, failedChecks: 0 }, { activeVUs: 3, failedChecks: 2 }]) {
      const quiet = { ...frame, ...noSample, ...counts };
      expect(metricsFrameSchema.parse(quiet)).toEqual(quiet);
    }
  });

  it.each([
    { reqPerSec: null },
    { reqPerSec: null, latencyMs: noSample.latencyMs },
    { latencyMs: noSample.latencyMs },
    { latencyMs: { ...sample.latencyMs, avg: null } },
    { httpFailureFraction: null },
    { ...noSample, httpFailureFraction: 0 },
    { ...noSample, activeVUs: null },
    { ...noSample, failedChecks: null },
  ])("rejects partially nulled sample or counter fields %j", (patch) => {
    expect(metricsFrameSchema.safeParse({ ...frame, ...patch }).success).toBe(false);
  });

  it.each([undefined, null, [], 1, "metrics"])("rejects nonobject frame declarations %j", (input) => {
    expect(metricsFrameSchema.safeParse(input).success).toBe(false);
  });

  it("exports inferred types and component validators through the public entry point", () => {
    const parsed: shared.MetricsFrame = shared.metricsFrameSchema.parse(frame);
    const window: shared.MetricsWindow = parsed.window;
    const latency: shared.MetricsLatency = parsed.latencyMs;
    expect(shared.metricsFrameSchema).toBe(metricsFrameSchema);
    expect(shared.metricsWindowSchema.parse(window)).toEqual(window);
    expect(shared.metricsLatencySchema.parse(latency)).toEqual(latency);
    // @ts-expect-error The closed union admits only type "metrics".
    const terminal: shared.MetricsFrame = { ...frame, type: "terminal" };
    expect(shared.metricsFrameSchema.safeParse(terminal).success).toBe(false);
    // @ts-expect-error Version is the literal 1.
    const reissued: shared.MetricsFrame = { ...frame, version: 2 };
    expect(shared.metricsFrameSchema.safeParse(reissued).success).toBe(false);
    // @ts-expect-error Counters are required nonnegative safe integers, never null.
    const counted: shared.MetricsFrame = { ...frame, activeVUs: null };
    expect(shared.metricsFrameSchema.safeParse(counted).success).toBe(false);
  });

  it("matches the WS metrics guide against the declared contract", () => {
    const doc = readFileSync("docs/api/ws-metrics.md", "utf8");
    for (const fragment of ["`/ws/runs/{runId}`", "`/api/ws/runs/{runId}`", "Next proxy",
      "orchestrator", "monotonic", "run-relative", "cumulative", "deferred",
      "declaration-only", "1000"]) expect(doc).toContain(fragment);
    const frameKeys = ["version", "type", "runId", "seq", "window", "reqPerSec",
      "latencyMs", "httpFailureFraction", "activeVUs", "failedChecks"];
    for (const key of [...frameKeys, ...Object.keys(metricsWindowSchema.shape),
      ...Object.keys(metricsLatencySchema.shape)]) expect(doc).toContain(key);
  });
});
