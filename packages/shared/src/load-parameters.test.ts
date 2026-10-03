import { describe, expect, it } from "vitest";
import { loadParametersSchema } from "./load-parameters";
import * as shared from "./index";

const max = Number.MAX_SAFE_INTEGER;
const invalidPositive = [undefined, 0, -1, 0.5, max + 1, NaN, Infinity, -Infinity, "1000", null];
const invalidNonnegative = [undefined, -1, 0.5, max + 1, NaN, Infinity, -Infinity, "0", null];

const latency = {
  metric: "http_req_duration", aggregator: "p95", unit: "ms", operator: "lt", expected: 500,
};
const rate = {
  metric: "http_req_failed", aggregator: "rate", unit: "fraction", operator: "lte", expected: 0.01,
};
const parameters = {
  version: 1,
  profile: { kind: "constant-vus", vus: 2, durationMs: 1000 },
  thresholds: [latency, rate],
  thresholdPolicy: "final-pass-fail",
};

describe("standalone global load declarations", () => {
  it("accepts explicit constant load and multiple thresholds for the same metric", () => {
    const input = { ...parameters, thresholds: [latency, { ...latency, aggregator: "avg" }, rate] };
    expect(loadParametersSchema.parse(input)).toEqual(input);
  });

  it("accepts an explicitly empty threshold list, not an omitted list", () => {
    expect(loadParametersSchema.parse({ ...parameters, thresholds: [] }).thresholds).toEqual([]);
  });

  it("exports inferred types and component validators through the public entry point", () => {
    const parsed: shared.LoadParameters = shared.loadParametersSchema.parse(parameters);
    const profile: shared.LoadProfile = parsed.profile;
    const stage: shared.LoadStage = { durationMs: 1, targetVus: 0 };
    const threshold: shared.LoadThreshold = parsed.thresholds[0]!;
    const policy: shared.LoadThresholdPolicy = parsed.thresholdPolicy;
    expect(shared.loadProfileSchema.parse(profile)).toEqual(profile);
    expect(shared.loadStageSchema.parse(stage)).toEqual(stage);
    expect(shared.loadThresholdSchema.parse(threshold)).toEqual(threshold);
    expect(shared.loadThresholdPolicySchema.parse(policy)).toBe(policy);
    expect(shared.loadParametersSchema).toBe(loadParametersSchema);
    // @ts-expect-error Latency metrics cannot declare fractional-rate units.
    const wrongPair: shared.LoadThreshold = { ...latency, metric: "http_req_duration", aggregator: "p95", unit: "fraction", operator: "lt" };
    expect(shared.loadThresholdSchema.safeParse(wrongPair).success).toBe(false);
  });

  it.each([
    { kind: "constant-vus", vus: 1, durationMs: 1 },
    { kind: "constant-vus", vus: max, durationMs: max },
    { kind: "staged-vus", startVus: 0, stages: [{ durationMs: 1, targetVus: 1 }] },
    { kind: "staged-vus", startVus: 1, stages: [{ durationMs: 1, targetVus: 0 }] },
    { kind: "staged-vus", startVus: max, stages: [{ durationMs: max, targetVus: max }] },
  ])("accepts approved safe-integer profile boundaries %j", (profile) => {
    expect(shared.loadProfileSchema.parse(profile)).toEqual(profile);
  });

  it("preserves stage and threshold order without mutating deeply frozen input", () => {
    const stages = Object.freeze([
      Object.freeze({ durationMs: 30, targetVus: 4 }),
      Object.freeze({ durationMs: 10, targetVus: 0 }),
    ]);
    const thresholds = Object.freeze([Object.freeze(rate), Object.freeze(latency), Object.freeze(latency)]);
    const input = Object.freeze({ ...parameters, thresholds,
      profile: Object.freeze({ kind: "staged-vus", startVus: 0, stages }) });
    const parsed = loadParametersSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.thresholds).not.toBe(thresholds);
    if (parsed.profile.kind === "staged-vus") {
      expect(parsed.profile.stages).not.toBe(stages);
      expect(parsed.profile.stages[0]).not.toBe(stages[0]);
    }
  });

  it.each(["eq", "ne", "lt", "lte", "gt", "gte"])("accepts numeric operator %s for both metrics", (operator) => {
    for (const threshold of [latency, rate]) {
      expect(shared.loadThresholdSchema.parse({ ...threshold, operator }).operator).toBe(operator);
    }
  });

  it.each(["avg", "p90", "p95", "p99"])("accepts fixed latency aggregator %s", (aggregator) => {
    expect(shared.loadThresholdSchema.parse({ ...latency, aggregator }).aggregator).toBe(aggregator);
  });

  it.each([0, 0.25, 1, Number.MAX_VALUE])("accepts finite nonnegative latency %s ms", (expected) => {
    expect(shared.loadThresholdSchema.parse({ ...latency, expected }).expected).toBe(expected);
  });

  it.each([0, 0.25, 1])("accepts fraction boundary %s", (expected) => {
    expect(shared.loadThresholdSchema.parse({ ...rate, expected }).expected).toBe(expected);
  });

  it.each(invalidPositive)("rejects nonpositive, unsafe or nonnumeric duration/count %s", (value) => {
    for (const field of ["vus", "durationMs"]) {
      expect(shared.loadProfileSchema.safeParse({ ...parameters.profile, [field]: value }).success).toBe(false);
    }
    expect(shared.loadStageSchema.safeParse({ durationMs: value, targetVus: 1 }).success).toBe(false);
  });

  it.each(invalidNonnegative)("rejects unsafe or nonnumeric staged counts %s", (value) => {
    expect(shared.loadProfileSchema.safeParse({ kind: "staged-vus", startVus: value,
      stages: [{ durationMs: 1, targetVus: 1 }] }).success).toBe(false);
    expect(shared.loadStageSchema.safeParse({ durationMs: 1, targetVus: value }).success).toBe(false);
  });

  it.each([
    { kind: undefined }, { kind: "constant-arrival-rate" }, { kind: "ramping-arrival-rate" },
    { kind: "shared-iterations" }, { kind: "per-vu-iterations" },
    { startVus: 0 }, { stages: [] }, { duration: "1s" }, { iterations: 1 },
    { gracefulStop: "1s" }, { startupDelayMs: 1 }, { extra: true },
  ])("rejects missing tags and constant-profile alternatives %j", (patch) => {
    expect(shared.loadProfileSchema.safeParse({ ...parameters.profile, ...patch }).success).toBe(false);
  });

  it.each([
    { stages: undefined }, { stages: [] }, { stages: {} }, { stages: [null] },
    { stages: [{ durationMs: 1 }] }, { stages: [{ durationMs: 1, targetVus: 1, extra: true }] },
    { startVus: undefined }, { vus: 1 }, { durationMs: 1 }, { extra: true },
  ])("rejects malformed or hybrid staged profiles %j", (patch) => {
    expect(shared.loadProfileSchema.safeParse({ kind: "staged-vus", startVus: 0,
      stages: [{ durationMs: 1, targetVus: 1 }], ...patch }).success).toBe(false);
  });

  it.each([
    { version: undefined }, { version: 0 }, { version: 2 }, { version: "1" },
    { profile: undefined }, { profile: null }, { profile: [] }, { profile: [parameters.profile] },
    { thresholds: undefined }, { thresholds: {} }, { thresholds: [null] },
    { thresholds: ["p(95)<500"] }, { thresholdPolicy: undefined },
    { thresholdPolicy: "abort-on-fail" }, { scenarios: [] }, { nodeOverrides: {} },
    { abortOnFail: true }, { delayAbortEval: "1s" }, { extra: true },
  ])("rejects missing fields, alternate policies and envelope extras %j", (patch) => {
    expect(loadParametersSchema.safeParse({ ...parameters, ...patch }).success).toBe(false);
  });

  it.each([
    { metric: undefined }, { metric: "checks" }, { metric: "custom" },
    { metric: "http_req_duration{tag:value}" }, { aggregator: undefined },
    { aggregator: "p50" }, { aggregator: "p(95)" }, { aggregator: "rate" },
    { unit: undefined }, { unit: "s" }, { operator: undefined }, { operator: "<" },
    { operator: "contains-literal" }, { expected: undefined }, { expected: "500" },
    { expected: -1 }, { expected: NaN }, { expected: Infinity }, { expected: -Infinity },
    { tags: {} }, { predicate: () => true }, { abortOnFail: true }, { extra: true },
  ])("rejects unsupported latency threshold fields %j", (patch) => {
    expect(shared.loadThresholdSchema.safeParse({ ...latency, ...patch }).success).toBe(false);
  });

  it.each([
    { aggregator: "avg" }, { aggregator: "p90" }, { unit: "ms" }, { unit: "percent" },
    { expected: -0.01 }, { expected: 100 }, { expected: NaN }, { expected: Infinity },
    { expected: -Infinity }, { expected: "0.01" }, { expected: null },
  ])("rejects invalid rate pairings and fraction values %j", (patch) => {
    expect(shared.loadThresholdSchema.safeParse({ ...rate, ...patch }).success).toBe(false);
  });

  it.each([undefined, null, [], 1, "load"])("rejects nonobject declarations %j", (input) => {
    expect(loadParametersSchema.safeParse(input).success).toBe(false);
  });

  it("rejects failure rates above one", () => {
    expect(loadParametersSchema.safeParse({ ...parameters,
      thresholds: [{ ...rate, expected: 1.01 }] }).success).toBe(false);
  });

  it("rejects metric and unit mismatches", () => {
    expect(loadParametersSchema.safeParse({ ...parameters,
      thresholds: [{ ...latency, unit: "fraction" }] }).success).toBe(false);
  });

  it("rejects staged profiles with no positive load", () => {
    expect(loadParametersSchema.safeParse({ ...parameters,
      profile: { kind: "staged-vus", startVus: 0,
        stages: [{ durationMs: 1000, targetVus: 0 }] } }).success).toBe(false);
  });
});
