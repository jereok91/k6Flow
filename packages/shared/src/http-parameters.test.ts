import { describe, expect, it } from "vitest";
import { httpBodySchema, httpMethodSchema, httpNamedValueSchema, httpParametersSchema } from "./index";
import type { HttpBody, HttpMethod, HttpNamedValue, HttpParameters } from "./index";

const literal = (value: string) => ({ kind: "literal" as const, value });
const reference = { kind: "reference" as const,
  reference: { producerNodeId: "producer", output: "whole-value" } };
const minimal = { method: "GET", url: literal("https://example.test/${path}") };

describe("standalone HTTP parameters", () => {
  it("accepts minimal input without defaults, coercion or placeholder interpretation", () => {
    const input: HttpParameters = JSON.parse(JSON.stringify(minimal));
    expect(httpParametersSchema.parse(input)).toEqual(minimal);
    expect(input).toEqual(minimal);
    expect(Object.keys(httpParametersSchema.parse(input))).toEqual(["method", "url"]);
  });

  it("accepts whole dynamic URL/header/query values and preserves ordered duplicates", () => {
    const named: HttpNamedValue = { name: "Authorization", value: reference };
    const body: HttpBody = { kind: "text", value: reference };
    const method: HttpMethod = "custom-method";
    const input: HttpParameters = { method, url: reference,
      headers: [named, named], query: [{ name: "q", value: reference }], body };
    const before: HttpParameters = JSON.parse(JSON.stringify(input));
    expect(httpParametersSchema.parse(input)).toEqual(before);
    expect(input).toEqual(before);
    expect(httpNamedValueSchema.parse(named)).toEqual(named);
    expect(httpMethodSchema.parse(method)).toBe(method);
  });

  it.each([
    { kind: "none" }, { kind: "text", value: literal("") },
    { kind: "json", value: { kind: "literal", value: { items: [null, true, 1, "${token}"] } } },
    { kind: "json", value: { kind: "literal", value: null } },
    { kind: "json", value: reference },
  ])("accepts approved body variant: %j", (body) => {
    expect(httpBodySchema.parse(body)).toEqual(body);
    expect(httpParametersSchema.parse({ ...minimal, body })).toEqual({ ...minimal, body });
  });

  it.each([
    { ...minimal, method: "" }, { ...minimal, method: "GET POST" }, { ...minimal, method: "GET\n" },
    { ...minimal, method: 1 }, { ...minimal, url: "https://example.test" },
    { ...minimal, headers: { name: "X", value: literal("x") } },
    { ...minimal, query: [{ name: "", value: literal("x") }] },
    { ...minimal, headers: [{ name: "X", value: { kind: "literal", value: 1 } }] },
    { ...minimal, body: { kind: "none", value: null } },
    { ...minimal, body: { kind: "text", value: { kind: "literal", value: {} } } },
    { ...minimal, body: { kind: "json", value: { kind: "literal", value: { x: NaN } } } },
    { ...minimal, body: { kind: "multipart", files: [] } },
    { ...minimal, body: { kind: "form-urlencoded", fields: [] } },
    { ...minimal, authentication: {} }, { ...minimal, timeout: 1000 },
  ])("rejects invalid or out-of-scope HTTP fields: %j", (input) => {
    expect(httpParametersSchema.safeParse(input).success).toBe(false);
  });

  it("locates malformed nested reference identities at the consuming field", () => {
    const result = httpParametersSchema.safeParse({ ...minimal,
      query: [{ name: "q", value: { kind: "reference", reference: { producerNodeId: " ", output: "x" } } }],
    });
    expect(result.error?.issues[0]?.path).toEqual(["query", 0, "value", "reference", "producerNodeId"]);
  });
});
