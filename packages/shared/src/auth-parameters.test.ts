import { describe, expect, it } from "vitest";
import {
  authJsonPathSegmentSchema, authMethodSchema, authOutputFailurePolicySchema,
  authOutputSchema, authOutputSelectorSchema, authOutputTypeSchema, authParametersSchema,
  httpParametersSchema, producerOutputReferenceSchema,
  type AuthJsonPathSegment, type AuthMethod, type AuthOutput,
  type AuthOutputFailurePolicy, type AuthOutputSelector, type AuthOutputType,
  type AuthParameters,
} from "./index";

const request = {
  method: "POST", url: { kind: "literal", value: "https://example.test/login" },
  body: { kind: "none" },
} as const;
const output: AuthOutput = {
  name: "token", required: true, expectedType: "string",
  selector: { kind: "json-path", path: ["session", "token"] },
};
const parameters = (): AuthParameters => ({
  method: { kind: "http", request }, outputs: [output],
  onOutputFailure: "stop-current-vu-iteration",
});

it("rejects unsupported authentication methods", () => {
  expect(authParametersSchema.safeParse({
    ...parameters(), method: { kind: "oauth2" },
  }).success).toBe(false);
});

describe("standalone authentication boundary", () => {
  it("preserves all three extractors and inferred public types", () => {
    const selector: AuthOutputSelector = { kind: "cookie", name: "session_id" };
    const expectedType: AuthOutputType = "string";
    const policy: AuthOutputFailurePolicy = "stop-current-vu-iteration";
    const method: AuthMethod = { kind: "http", request };
    const segment: AuthJsonPathSegment = 0;
    const input: AuthParameters = {
      method, onOutputFailure: policy,
      outputs: [output,
        { ...output, name: "trace", selector: { kind: "header", name: "X-Trace" } },
        { ...output, name: "session", selector, expectedType },
        { ...output, name: "profile", expectedType: "json",
          selector: { kind: "json-path", path: ["users", segment, "profile"] } }],
    };
    const before: AuthParameters = JSON.parse(JSON.stringify(input));
    expect(authParametersSchema.parse(input)).toEqual(before);
    expect(input).toEqual(before);
    expect(authMethodSchema.parse(method)).toEqual(method);
    expect(authOutputTypeSchema.parse(expectedType)).toBe(expectedType);
    expect(authOutputFailurePolicySchema.parse(policy)).toBe(policy);
  });

  it("reuses HTTP literal and whole reference parameters without defaults", () => {
    const reference = { producerNodeId: "pool", output: "login" };
    const http = {
      method: "custom", url: { kind: "reference", reference },
      headers: [{ name: "X-Input", value: { kind: "reference", reference } }],
      query: [{ name: "q", value: { kind: "literal", value: "${literal}" } }],
      body: { kind: "json", value: { kind: "literal", value: '{"user": "sample"}' } },
    };
    const parsed = authParametersSchema.parse({ ...parameters(),
      method: { kind: "http", request: http } });
    expect(parsed.method.request).toEqual(httpParametersSchema.parse(http));
    expect(producerOutputReferenceSchema.parse(reference)).toEqual(reference);
    const minimal = { method: "GET", url: request.url };
    expect(authMethodSchema.parse({ kind: "http", request: minimal }).request).toEqual(minimal);
    const text = { ...minimal, body: { kind: "text", value: { kind: "reference", reference } } };
    expect(authMethodSchema.parse({ kind: "http", request: text }).request).toEqual(text);
  });

  it.each(["", " ", null, 7])("rejects invalid output identity %j", (name) => {
    expect(authOutputSchema.safeParse({ ...output, name }).success).toBe(false);
  });

  it("compares identities exactly and reports the duplicate location", () => {
    const input = { ...parameters(), outputs: [output, { ...output }] };
    const result = authParametersSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["outputs", 1, "name"]);
    expect(authParametersSchema.parse({ ...input,
      outputs: [output, { ...output, name: " token " }] }).outputs[1]?.name).toBe(" token ");
  });

  it.each([[], undefined, null].map((outputs) => ({ outputs })))("requires nonempty outputs $outputs", ({ outputs }) => {
    expect(authParametersSchema.safeParse({ ...parameters(), outputs }).success).toBe(false);
  });

  it.each([false, undefined, "true"])("requires explicit required true, not %j", (required) => {
    expect(authOutputSchema.safeParse({ ...output, required }).success).toBe(false);
  });

  it.each([undefined, "continue", "stop-test", "stop-vu", "retry"])(
    "rejects unapproved failure policy %j", (onOutputFailure) => {
      expect(authParametersSchema.safeParse({ ...parameters(), onOutputFailure }).success).toBe(false);
    });

  it.each([undefined, "number", "boolean", "object", "jwt"])(
    "requires explicit string/JSON category, not %j", (expectedType) => {
      expect(authOutputSchema.safeParse({ ...output, expectedType }).success).toBe(false);
    });

  it.each(["header", "cookie"] as const)("constrains %s to string outputs", (kind) => {
    const selector = { kind, name: "session_id" };
    expect(authOutputSchema.safeParse({ ...output, selector }).success).toBe(true);
    expect(authOutputSchema.safeParse({ ...output, selector, expectedType: "json" }).success).toBe(false);
  });
});

describe("structured selectors", () => {
  it.each([[], [""], ["0", 0], ["__proto__", "constructor", "prototype"],
    ["$.token", "{{token}}", "x()"], [Number.MAX_SAFE_INTEGER]].map((path) => ({ path })))(
    "preserves literal keys and array indices $path", ({ path }) => {
      expect(authOutputSelectorSchema.parse({ kind: "json-path", path })).toEqual({ kind: "json-path", path });
    });

  it.each([undefined, "$.token", [null], [true], [-1], [0.5], [Infinity],
    [NaN], [Number.MAX_SAFE_INTEGER + 1], [{ key: "token" }], [() => "token"]].map((path) => ({ path })))(
    "rejects malformed JSON paths $path", ({ path }) => {
      expect(authOutputSelectorSchema.safeParse({ kind: "json-path", path }).success).toBe(false);
    });

  it.each(["header", "cookie"] as const)("rejects malformed %s names", (kind) => {
    for (const name of [undefined, "", " ", "a b", "x\r\ny", "a:b", "a=b", "a;b", 1]) {
      expect(authOutputSelectorSchema.safeParse({ kind, name }).success).toBe(false);
    }
    expect(authOutputSelectorSchema.parse({ kind, name: "X-Session_1" })).toEqual({ kind, name: "X-Session_1" });
  });

  it.each([
    { kind: "javascript", expression: "response.token" },
    { kind: "jsonpath", expression: "$.token" },
    { kind: "template", value: "{{token}}" },
    { kind: "json-path", path: ["token"], expression: "x()" },
    { kind: "header", name: "X-Token", path: [] },
    { kind: "cookie", name: "session", domain: "example.test" },
  ])("rejects executable/extended selector shapes %j", (selector) => {
    expect(authOutputSelectorSchema.safeParse(selector).success).toBe(false);
  });

  it("rejects unknown fields at every enclosing boundary and malformed HTTP", () => {
    const input = parameters();
    for (const invalid of [
      { ...input, extra: true },
      { ...input, method: { ...input.method, extra: true } },
      { ...input, method: { kind: "basic-auth", request } },
      { ...input, method: { kind: "http", request: { ...request, extra: true } } },
      { ...input, method: { kind: "http", request: { ...request, method: "bad method" } } },
      { ...input, outputs: [{ ...output, extra: true }] },
      { ...input, outputs: [{ ...output, selector: { kind: "json-path" } }] },
    ]) expect(authParametersSchema.safeParse(invalid).success).toBe(false);
    expect(authJsonPathSegmentSchema.safeParse("ordinary.key").success).toBe(true);
  });
});
