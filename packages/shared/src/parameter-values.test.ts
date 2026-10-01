import { describe, expect, it } from "vitest";
import {
  jsonParameterValueSchema, jsonValueSchema, producerOutputReferenceSchema,
  stringParameterValueSchema,
} from "./index";
import type { JsonParameterValue, JsonValue, ProducerOutputReference, StringParameterValue } from "./index";

describe("parameter values", () => {
  it("rejects executable-shaped values instead of accepting an expression language", () => {
    expect(stringParameterValueSchema.safeParse({
      kind: "javascript", source: "return process.env.TOKEN",
    }).success).toBe(false);
  });

  it("preserves whole literals and references with inferred public types", () => {
    const literal: StringParameterValue = { kind: "literal", value: "Bearer ${token} {{url}}" };
    const reference: ProducerOutputReference = { producerNodeId: " auth ", output: " token " };
    expect(stringParameterValueSchema.parse(literal)).toEqual(literal);
    expect(stringParameterValueSchema.parse({ kind: "reference", reference })).toEqual({
      kind: "reference", reference,
    });
    const data: JsonValue = { kind: "reference", reference, values: [null, true, 2, "${x}"] };
    const json: JsonParameterValue = { kind: "literal", value: data };
    expect(jsonParameterValueSchema.parse(json)).toEqual(json);
    expect(json).toEqual({ kind: "literal", value: data });
  });

  it.each([
    "plain", { kind: "literal", value: 1 }, { kind: "literal", value: "x", extra: true },
    { kind: "segments", segments: [] }, { kind: "template", value: "${x}" },
    { kind: "selector", value: "$.token" }, { kind: "secret", name: "token" },
    { kind: "reference", reference: { producerNodeId: "", output: "x" } },
    { kind: "reference", reference: { producerNodeId: "x", output: "  " } },
    { kind: "reference", reference: { producerNodeId: 1, output: "x" } },
    { kind: "reference", reference: { producerNodeId: "x" } },
    { kind: "reference", reference: { producerNodeId: "x", output: "x", selector: "$" } },
    { kind: "reference", reference: { producerNodeId: "x", output: "x" }, value: "prefix" },
  ])("rejects malformed or unsupported string values: %j", (value) => {
    expect(stringParameterValueSchema.safeParse(value).success).toBe(false);
  });

  it("uses the same identity rules without asserting output support", () => {
    expect(producerOutputReferenceSchema.safeParse({
      producerNodeId: "unknown-producer", output: "unsupported-output",
    }).success).toBe(true);
  });

  it.each([undefined, NaN, Infinity, -Infinity, 1n, Symbol("x"), () => 1,
    new Date(), new Map(), new Set(), /x/, new Uint8Array(), new (class Payload {})(),
    [undefined], new Array(1), { nested: undefined }, { nested: () => 1 },
  ])("rejects non-JSON data: %s", (value) => {
    expect(jsonParameterValueSchema.safeParse({ kind: "literal", value }).success).toBe(false);
  });

  it("rejects cycles/accessors/hidden data and reports nested issue locations", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    let accessed = false;
    const accessor = { get token() { accessed = true; return "x"; } };
    for (const value of [cycle, accessor, Object.defineProperty({}, "x", { value: 1 }),
      { [Symbol("hidden")]: 1 }, Object.assign([], { extra: "x" })]) {
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
    }
    expect(accessed).toBe(false);
    const result = jsonParameterValueSchema.safeParse({ kind: "literal", value: { nested: [Infinity] } });
    expect(result.error?.issues[0]?.path).toEqual(["value", "nested", 0]);
    const shared = { ok: true };
    expect(jsonValueSchema.parse([shared, shared])).toEqual([shared, shared]);
  });
});
