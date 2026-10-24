import { describe, expect, it } from "vitest";
import { appendFrameToChart, applyFrameToMetrics, frameWindowStartSec } from "./run-metrics";
import type { PanelChartSeries, PanelMetricValues } from "./run-metrics";

const previous: PanelMetricValues = {
  vus: 7,
  requestRate: 2.5,
  avgDuration: 120,
  p95Duration: 240,
  errorRate: 0.02,
};

const emptyChart: PanelChartSeries = {
  time: [], rps: [], avgLatency: [], p95Latency: [], p99Latency: [], vus: [], errorRate: [],
};

const populatedChart: PanelChartSeries = {
  time: [0, 1],
  rps: [1, 2],
  avgLatency: [10, 20],
  p95Latency: [30, 40],
  p99Latency: [50, 60],
  vus: [3, 4],
  errorRate: [0, 0.1],
};

const frame = {
  version: 1,
  type: "metrics",
  runId: "run-1",
  seq: 3,
  window: { startMs: 3000, durationMs: 1000 },
  reqPerSec: 12.5,
  latencyMs: { avg: 45.5, p90: 60, p95: 88.25, p99: 120 },
  httpFailureFraction: 0.25,
  activeVUs: 11,
  failedChecks: 2,
};

// A no-request window: the shared contract nulls every sample-derived value and
// only the VU gauge / failed checks carry values.
const emptyFrame = {
  ...frame,
  reqPerSec: null,
  latencyMs: { avg: null, p90: null, p95: null, p99: null },
  httpFailureFraction: null,
};

describe("frameWindowStartSec", () => {
  it("converts the window start from ms to the chart's seconds", () => {
    expect(frameWindowStartSec(frame)).toBe(3);
    expect(frameWindowStartSec({ ...frame, window: { startMs: 1500 } })).toBe(1.5);
  });

  it("falls back to 0 without a usable window", () => {
    expect(frameWindowStartSec({})).toBe(0);
    expect(frameWindowStartSec({ window: null })).toBe(0);
    expect(frameWindowStartSec({ window: { startMs: null } })).toBe(0);
  });
});

describe("applyFrameToMetrics", () => {
  it("maps every sample field of a frame", () => {
    expect(applyFrameToMetrics(previous, frame)).toEqual({
      vus: 11,
      requestRate: 12.5,
      avgDuration: 45.5,
      p95Duration: 88.25,
      errorRate: 0.25,
    });
  });

  // A no-request window nulls the sample values but still reports the VU
  // gauge, which the panel takes exactly like today (activeVUs ?? previous).
  it("keeps the previous sample values for a null sample field", () => {
    expect(applyFrameToMetrics(previous, emptyFrame)).toEqual({ ...previous, vus: 11 });
  });

  it("keeps the previous value for missing fields", () => {
    expect(applyFrameToMetrics(previous, {})).toEqual(previous);
    expect(applyFrameToMetrics(previous, { latencyMs: null, reqPerSec: undefined })).toEqual(previous);
  });

  it("uses the value 0 instead of falling back when the frame reports 0", () => {
    const zeroed = { ...frame, reqPerSec: 0, latencyMs: { avg: 0, p95: 0 }, activeVUs: 0, httpFailureFraction: 0 };
    expect(applyFrameToMetrics(previous, zeroed)).toEqual({
      vus: 0, requestRate: 0, avgDuration: 0, p95Duration: 0, errorRate: 0,
    });
  });

  it("preserves fields the frame does not own", () => {
    const withExtras = { ...previous, iterations: 9, dataReceived: 10, dataSent: 11 };
    const next = applyFrameToMetrics(withExtras, frame);
    expect(next).toMatchObject({ iterations: 9, dataReceived: 10, dataSent: 11 });
    expect(withExtras.iterations).toBe(9);
  });
});

describe("appendFrameToChart", () => {
  it("appends one point per series from the frame", () => {
    expect(appendFrameToChart(emptyChart, frame)).toEqual({
      time: [3], rps: [12.5], avgLatency: [45.5], p95Latency: [88.25], p99Latency: [120], vus: [11], errorRate: [0.25],
    });
  });

  it("keeps earlier points and appends at the end", () => {
    expect(appendFrameToChart(populatedChart, frame)).toEqual({
      time: [0, 1, 3],
      rps: [1, 2, 12.5],
      avgLatency: [10, 20, 45.5],
      p95Latency: [30, 40, 88.25],
      p99Latency: [50, 60, 120],
      vus: [3, 4, 11],
      errorRate: [0, 0.1, 0.25],
    });
  });

  it("appends 0 for a no-request window instead of skipping the point", () => {
    expect(appendFrameToChart(emptyChart, emptyFrame)).toEqual({
      time: [3], rps: [0], avgLatency: [0], p95Latency: [0], p99Latency: [0], vus: [11], errorRate: [0],
    });
  });

  it("appends 0 for missing fields", () => {
    expect(appendFrameToChart(emptyChart, {})).toEqual({
      time: [0], rps: [0], avgLatency: [0], p95Latency: [0], p99Latency: [0], vus: [0], errorRate: [0],
    });
  });

  it("does not mutate the previous series", () => {
    const before = structuredClone(populatedChart);
    appendFrameToChart(populatedChart, frame);
    expect(populatedChart).toEqual(before);
  });
});
