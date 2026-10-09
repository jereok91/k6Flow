import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_MAX_EVENTS, DIAGNOSTIC_MAX_NODES, diagnosticEventSchema, diagnosticMetadataSchema } from "./diagnostic";

describe("bounded diagnostic contract", () => {
  it("allows only unique, bounded IDs in ordered metadata", () => {
    expect(diagnosticMetadataSchema.parse({ nodeIds: ["b", "a"] }).nodeIds).toEqual(["b", "a"]);
    for (const nodeIds of [[], [""], ["a", "a"], ["a".repeat(129)], Array.from({ length: DIAGNOSTIC_MAX_NODES + 1 }, (_, i) => String(i))]) {
      expect(diagnosticMetadataSchema.safeParse({ nodeIds }).success).toBe(false);
    }
    expect(diagnosticMetadataSchema.safeParse({ nodeIds: ["a"], parameters: {} }).success).toBe(false);
  });
  it("enforces UTF-8 byte boundaries for both metadata and event IDs", () => {
    const id = "é".repeat(64);
    const event = { seq: DIAGNOSTIC_MAX_EVENTS, nodeId: id, event: "exit", elapsedMs: 0, httpStatus: 200, outcome: "success", reason: "none" };
    expect(diagnosticMetadataSchema.safeParse({ nodeIds: [id] }).success).toBe(true);
    expect(diagnosticEventSchema.safeParse(event).success).toBe(true);
    for (const invalid of [id + "a", "é".repeat(65)]) {
      expect(diagnosticMetadataSchema.safeParse({ nodeIds: [invalid] }).success).toBe(false);
      expect(diagnosticEventSchema.safeParse({ ...event, nodeId: invalid }).success).toBe(false);
    }
    expect(diagnosticEventSchema.safeParse({ ...event, seq: DIAGNOSTIC_MAX_EVENTS + 1 }).success).toBe(false);
  });
  it("accepts numeric event fields and closed safe outcomes only", () => {
    const event = { seq: 1, nodeId: "a", event: "exit", elapsedMs: 5, httpStatus: 200, outcome: "success", reason: "none" };
    expect(diagnosticEventSchema.parse(event)).toEqual(event);
    for (const patch of [ { seq: DIAGNOSTIC_MAX_EVENTS + 1 }, { seq: 0 }, { elapsedMs: Infinity },
      { elapsedMs: 30001 }, { httpStatus: "200" }, { httpStatus: 600 }, { reason: "server secret" },
      { url: "secret" }, { nodeId: "" }, { event: "complete" }, { outcome: "pending" },
    ]) expect(diagnosticEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
    expect(diagnosticEventSchema.safeParse({ ...event, nodeId: "", event: "complete", elapsedMs: 0, httpStatus: 0 }).success).toBe(true);
  });
});
