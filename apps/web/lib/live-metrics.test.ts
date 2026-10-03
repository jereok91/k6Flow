// Textual-parity tests for the K6F3-04 hand-rolled frame validator.
//
// Source of truth (read for reference, deliberately NOT imported — apps/web must
// not gain a dependency on @k6flow/shared or zod): packages/shared/src/
// metrics-messages.ts → `metricsFrameSchema` (z.strictObject). The literal
// contract key list below is duplicated from that schema and asserted against the
// validator's exported METRICS_FRAME_KEYS, so any drift on either side fails here.

import { describe, expect, it } from "vitest";
import {
  METRICS_FRAME_KEYS,
  SUBPROTOCOL,
  appendWindow,
  buildWsUrl,
  emptyWindowList,
  formatFailurePercent,
  formatLatency,
  formatRate,
  validateMetricsFrame,
  wsProtocols,
} from "./live-metrics";

// Duplicate of the top-level keys of metricsFrameSchema — see header comment.
const CONTRACT_KEYS = [
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
];

const validFrame = () => ({
  version: 1,
  type: "metrics",
  runId: "run-0001",
  seq: 7,
  window: { startMs: 7000, durationMs: 1000 },
  reqPerSec: 12.5,
  latencyMs: { avg: 10.4, p90: 21, p95: 26, p99: 41 },
  httpFailureFraction: 0.025,
  activeVUs: 3,
  failedChecks: 1,
});

const windowAt = (seq: number) => ({
  ...validFrame(),
  seq,
  window: { startMs: seq * 1000, durationMs: 1000 },
});

describe("validateMetricsFrame", () => {
  // Positive side of every field rule is pinned by the full-fixture acceptance;
  // the table below carries the negative side of all 10 contract fields.
  it("exports exactly the contract's 10 top-level keys", () => {
    expect([...METRICS_FRAME_KEYS]).toEqual(CONTRACT_KEYS);
    expect(Object.keys(validFrame()).sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  it("accepts a full valid frame and returns it unchanged", () => {
    const frame = validFrame();
    expect(validateMetricsFrame(frame)).toEqual({ ok: true, frame });
  });

  it("accepts zero boundaries (seq 0, startMs 0, gauges 0, fraction 0 and 1)", () => {
    const zero = {
      ...validFrame(),
      seq: 0,
      window: { startMs: 0, durationMs: 1000 },
      reqPerSec: 0,
      latencyMs: { avg: 0, p90: 0, p95: 0, p99: 0 },
      httpFailureFraction: 1,
      activeVUs: 0,
      failedChecks: 0,
    };
    expect(validateMetricsFrame(zero).ok).toBe(true);
  });

  it("accepts the all-null no-request window", () => {
    const frame = {
      ...validFrame(),
      reqPerSec: null,
      latencyMs: { avg: null, p90: null, p95: null, p99: null },
      httpFailureFraction: null,
    };
    expect(validateMetricsFrame(frame).ok).toBe(true);
  });

  it("rejects non-objects without throwing", () => {
    for (const input of [null, undefined, 42, "metrics", [validFrame()]]) {
      expect(validateMetricsFrame(input).ok).toBe(false);
    }
  });

  const negatives: Array<[string, (frame: any) => void]> = [
    ["version must be the literal 1", (f) => { f.version = 2; }],
    ["version must be numeric", (f) => { f.version = "1"; }],
    ["type must be the literal metrics", (f) => { f.type = "summary"; }],
    ["runId must not be blank", (f) => { f.runId = "   "; }],
    ["runId must be a string", (f) => { f.runId = 42; }],
    ["seq must be nonnegative", (f) => { f.seq = -1; }],
    ["seq must be an integer", (f) => { f.seq = 1.5; }],
    ["seq must be a safe integer", (f) => { f.seq = Number.MAX_SAFE_INTEGER + 2; }],
    ["window.durationMs must be exactly 1000", (f) => { f.window.durationMs = 999; }],
    ["window.startMs must be nonnegative", (f) => { f.window.startMs = -1000; }],
    ["window.startMs must be an integer", (f) => { f.window.startMs = 0.5; }],
    ["reqPerSec must be a number or null", (f) => { f.reqPerSec = "12.5"; }],
    ["reqPerSec must be finite", (f) => { f.reqPerSec = Infinity; }],
    ["reqPerSec must be nonnegative", (f) => { f.reqPerSec = -1; }],
    ["latency.avg must be a number or null", (f) => { f.latencyMs.avg = "10"; }],
    ["latency.p99 must be nonnegative", (f) => { f.latencyMs.p99 = -3; }],
    ["httpFailureFraction must stay within [0,1]", (f) => { f.httpFailureFraction = 1.5; }],
    ["activeVUs must be a nonnegative integer", (f) => { f.activeVUs = 2.5; }],
    ["failedChecks must be nonnegative", (f) => { f.failedChecks = -1; }],
    ["a missing field is rejected", (f) => { delete f.failedChecks; }],
  ];
  for (const [name, mutate] of negatives) {
    it(`rejects: ${name}`, () => {
      const frame: any = validFrame();
      mutate(frame);
      expect(validateMetricsFrame(frame).ok).toBe(false);
    });
  }

  const trioRejects: Array<[string, unknown]> = [
    ["null reqPerSec with present latencies", { ...validFrame(), reqPerSec: null }],
    ["null latencies with present reqPerSec", { ...validFrame(), latencyMs: { avg: null, p90: null, p95: null, p99: null } }],
    ["partially nulled latencies", { ...validFrame(), latencyMs: { ...validFrame().latencyMs, p99: null } }],
    ["failure fraction nulled alone", { ...validFrame(), httpFailureFraction: null }],
    ["failure fraction present with a nulled trio", { ...validFrame(), reqPerSec: null, latencyMs: { avg: null, p90: null, p95: null, p99: null }, httpFailureFraction: 0.1 }],
  ];
  for (const [name, frame] of trioRejects) {
    it(`rejects: sample trio not null exactly together — ${name}`, () => {
      expect(validateMetricsFrame(frame).ok).toBe(false);
    });
  }

  it("rejects unknown top-level fields (strict-object parity)", () => {
    expect(validateMetricsFrame({ ...validFrame(), extra: true }).ok).toBe(false);
  });

  it("rejects unknown or missing nested fields", () => {
    const badWindow = { ...validFrame(), window: { startMs: 0, durationMs: 1000, drift: 1 } };
    const badLatency = { ...validFrame(), latencyMs: { ...validFrame().latencyMs, max: 99 } };
    const missingWindow = { ...validFrame(), window: { startMs: 7000 } };
    expect(validateMetricsFrame(badWindow).ok).toBe(false);
    expect(validateMetricsFrame(badLatency).ok).toBe(false);
    expect(validateMetricsFrame(missingWindow).ok).toBe(false);
  });
});

describe("appendWindow", () => {
  it("counts invalid frames as rejected and leaves the list untouched", () => {
    let list = appendWindow(emptyWindowList(), windowAt(0));
    list = appendWindow(list, { ...validFrame(), seq: -1 });
    expect(list.rejected).toBe(1);
    expect(list.frames).toHaveLength(1);
    expect(appendWindow(emptyWindowList(), "not a frame").rejected).toBe(1);
  });

  it("keeps only the last 60 windows (default cap evicts oldest)", () => {
    let list = emptyWindowList();
    for (let i = 0; i < 65; i += 1) list = appendWindow(list, windowAt(i));
    expect(list.frames).toHaveLength(60);
    expect(list.frames[0].seq).toBe(5);
    expect(list.frames[59].seq).toBe(64);
    expect(list.rejected).toBe(0);
  });

  it("honors a custom max", () => {
    let list = emptyWindowList();
    for (let i = 0; i < 5; i += 1) list = appendWindow(list, windowAt(i), 3);
    expect(list.frames).toHaveLength(3);
    expect(list.frames[0].seq).toBe(2);
  });

  it("flags an out-of-order seq without crashing", () => {
    let list = appendWindow(emptyWindowList(), windowAt(10));
    list = appendWindow(list, windowAt(4));
    expect(list.outOfOrder).toBe(true);
    expect(list.rejected).toBe(0);
    expect(list.frames).toHaveLength(2);
  });

  it("counts forward seq gaps without flagging out-of-order", () => {
    let list = appendWindow(emptyWindowList(), windowAt(1));
    list = appendWindow(list, windowAt(5));
    expect(list.outOfOrder).toBe(false);
    expect(list.seqGaps).toBe(1);
  });
});

describe("buildWsUrl", () => {
  it("maps an http origin to ws", () => {
    expect(buildWsUrl("http://localhost:3000", "run-1")).toBe("ws://localhost:3000/api/ws/runs/run-1");
  });

  it("maps an https origin to wss", () => {
    expect(buildWsUrl("https://web.example.com", "run-1")).toBe("wss://web.example.com/api/ws/runs/run-1");
  });

  it("escapes the runId path segment", () => {
    expect(buildWsUrl("https://web.example.com", "run/42 a")).toBe("wss://web.example.com/api/ws/runs/run%2F42%20a");
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(buildWsUrl("http://127.0.0.1:3000/", "r2")).toBe("ws://127.0.0.1:3000/api/ws/runs/r2");
  });
});

describe("wsProtocols", () => {
  it("pins the k6flow.bearer subprotocol constant", () => {
    expect(SUBPROTOCOL).toBe("k6flow.bearer");
  });

  it("offers subprotocol then token", () => {
    expect(wsProtocols("s3cret")).toEqual(["k6flow.bearer", "s3cret"]);
  });
});

describe("formatters", () => {
  it("renders null as an em dash", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatLatency(null)).toBe("—");
    expect(formatFailurePercent(null)).toBe("—");
  });

  it("formats req/s with one decimal", () => {
    expect(formatRate(12.34)).toBe("12.3");
    expect(formatRate(0)).toBe("0.0");
  });

  it("formats latencies with fixed integer milliseconds", () => {
    expect(formatLatency(10.6)).toBe("11");
    expect(formatLatency(0)).toBe("0");
  });

  it("formats the failure fraction as a percentage with one decimal", () => {
    expect(formatFailurePercent(0.025)).toBe("2.5%");
    expect(formatFailurePercent(0)).toBe("0.0%");
    expect(formatFailurePercent(1)).toBe("100.0%");
  });
});
