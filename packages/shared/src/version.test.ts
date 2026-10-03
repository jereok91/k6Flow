import { describe, expect, expectTypeOf, it } from "vitest";
import { CONTRACT_VERSION, versionEnvelopeSchema } from "./index";
import type { VersionEnvelope } from "./index";

describe("version envelope", () => {
  it("accepts the supported version", () => {
    expect(versionEnvelopeSchema.safeParse({ version: 1 })).toEqual({
      success: true,
      data: { version: 1 },
    });
  });

  it("rejects an unsupported version", () => {
    expect(versionEnvelopeSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it.each([
    ["older version", { version: 0 }],
    ["negative version", { version: -1 }],
    ["fractional version", { version: 1.5 }],
    ["string version", { version: "1" }],
    ["boolean version", { version: true }],
    ["null version", { version: null }],
    ["missing version", {}],
    ["unknown fields", { version: 1, payload: {} }],
    ["null envelope", null],
    ["undefined envelope", undefined],
    ["scalar envelope", 1],
    ["array envelope", [{ version: 1 }]],
  ])("rejects %s without coercion or defaults", (_name, input) => {
    expect(versionEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it("exports the supported version and its schema-inferred type", () => {
    const envelope: VersionEnvelope = { version: CONTRACT_VERSION };

    expect(versionEnvelopeSchema.parse(envelope)).toEqual({ version: 1 });
    expectTypeOf<VersionEnvelope>().toEqualTypeOf<{ version: 1 }>();
  });
});
