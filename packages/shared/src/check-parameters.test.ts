import { describe, expect, it } from "vitest";
import * as shared from "./index";

const parameters = {
  version: 1,
  response: { producerNodeId: "request", output: "response" },
  checks: [{ name: "status OK", kind: "status", operator: "eq", expected: 200 }],
  onCheckFailure: "record-failure-and-continue",
};

describe("standalone response checks", () => {
  it("accepts an explicitly bound status check with the fixed failure policy", () => {
    expect(shared.checkParametersSchema.safeParse(parameters).success).toBe(true);
  });

  it.each(["status", "duration-ms"])("accepts every numeric operator for %s", (kind) => {
    for (const operator of ["eq", "ne", "lt", "lte", "gt", "gte"]) {
      expect(shared.responseCheckSchema.parse({
        name: "numeric", kind, operator, expected: 200.5,
      })).toEqual({ name: "numeric", kind, operator, expected: 200.5 });
    }
  });

  it.each(["body-text", "header"])("accepts literal text predicates for %s", (kind) => {
    for (const predicate of [
      { operator: "exists" }, { operator: "eq", expected: "" },
      { operator: "ne", expected: "error" },
      { operator: "contains-literal", expected: "${token}.*" },
    ]) {
      const check = { name: "text", kind, predicate,
        ...(kind === "header" ? { header: "X-Trace" } : {}) };
      expect(shared.responseCheckSchema.parse(check)).toEqual(check);
    }
  });

  it.each([null, false, 0, "", [1, null], { kind: "reference",
    reference: { producerNodeId: "auth", output: "token" } }].map((value) => [value]))(
    "accepts literal JSON equality data %j", (expected) => {
      const check = { name: "json", kind: "json-path", path: ["users", 0, ""],
        predicate: { operator: "deep-eq", expected } };
      expect(shared.responseCheckSchema.parse(check)).toEqual(check);
    });

  it("supports root existence and exact structured keys without interpretation", () => {
    for (const path of [[], ["0", 0, "__proto__", "$.x", "{{token}}"]]) {
      expect(shared.responseCheckSchema.safeParse({ name: "exists", kind: "json-path",
        path, predicate: { operator: "exists" } }).success).toBe(true);
    }
    expect(shared.checkJsonPathSegmentSchema.parse(Number.MAX_SAFE_INTEGER))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    { version: 2 }, { version: "1" }, { version: undefined }, { response: undefined },
    { response: "latest" }, { response: { producerNodeId: " ", output: "response" } },
    { response: { producerNodeId: "request", output: "" } },
    { response: { ...parameters.response, latest: true } }, { checks: [] },
    { checks: undefined }, { onCheckFailure: undefined }, { onCheckFailure: "abort" },
    { onCheckFailure: "stop-current-vu-iteration" }, { script: "check()" },
  ])("rejects invalid envelopes %j", (patch) => {
    expect(shared.checkParametersSchema.safeParse({ ...parameters, ...patch }).success)
      .toBe(false);
  });

  it.each([
    { name: "" }, { name: " \t" }, { kind: "javascript" }, { operator: "regex" },
    { operator: "exists" }, { expected: "200" }, { expected: NaN },
    { expected: Infinity }, { expected: undefined }, { callback: () => true },
    { expression: "status === 200" }, { secret: "binding" },
  ])("rejects malformed or executable numeric declarations %j", (patch) => {
    expect(shared.responseCheckSchema.safeParse({ ...parameters.checks[0], ...patch })
      .success).toBe(false);
  });

  it.each([
    { operator: "contains", expected: "x" },
    { operator: "regex", expected: ".*" }, { operator: "eq", expected: 1 },
    { operator: "eq" }, { operator: "ne" }, { operator: "ne", expected: 1 },
    { operator: "ne", expected: "x", extra: true },
    { operator: "exists", expected: "x" },
    { operator: "exists", extra: true },
  ])("rejects unsupported text predicates %j", (predicate) => {
    for (const kind of ["body-text", "header"]) {
      expect(shared.responseCheckSchema.safeParse({ name: "bad", kind, predicate,
        ...(kind === "header" ? { header: "X-Trace" } : {}) }).success).toBe(false);
    }
  });

  it.each([[-1], [0.5], [Number.MAX_SAFE_INTEGER + 1], [null], "$.token"]
    .map((value) => [value]))(
    "rejects unstructured/invalid paths %j", (path) => {
      expect(shared.responseCheckSchema.safeParse({ name: "bad", kind: "json-path",
        path, predicate: { operator: "exists" } }).success).toBe(false);
    });

  it.each([undefined, Infinity, () => 1, new Date(), { value: undefined }])(
    "rejects non-JSON equality data %j", (expected) => {
      expect(shared.responseCheckSchema.safeParse({ name: "bad", kind: "json-path",
        path: [], predicate: { operator: "deep-eq", expected } }).success).toBe(false);
    });

  it("requires header identity and rejects extra JSON contract fields", () => {
    for (const header of [undefined, "", "bad name"]) {
      expect(shared.responseCheckSchema.safeParse({ name: "header", kind: "header",
        header, predicate: { operator: "exists" } }).success).toBe(false);
    }
    for (const predicate of [{ operator: "eq", expected: {} },
      { operator: "ne", expected: {} }, { operator: "exists", expected: null }]) {
      expect(shared.responseCheckSchema.safeParse({ name: "json", kind: "json-path",
        path: [], predicate }).success).toBe(false);
    }
  });

  it("reports duplicate identities at the later name and preserves exact names/order", () => {
    const first = parameters.checks[0]!;
    const result = shared.checkParametersSchema.safeParse({ ...parameters,
      checks: [first, { ...first, kind: "duration-ms" }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["checks", 1, "name"]);
    const distinct = { ...parameters, checks: [first, { ...first, name: "Status OK" }] };
    const parsed: shared.CheckParameters = shared.checkParametersSchema.parse(distinct);
    const check: shared.ResponseCheck = parsed.checks[0]!;
    const policy: shared.CheckFailurePolicy = parsed.onCheckFailure;
    const operator: shared.CheckNumericOperator = "eq";
    const segment: shared.CheckJsonPathSegment = 0;
    expect([check.name, policy, operator, segment])
      .toEqual([first.name, "record-failure-and-continue", "eq", 0]);
    expect(parsed).toEqual(distinct);
    expect(distinct.checks).toEqual([first, { ...first, name: "Status OK" }]);
  });
});
