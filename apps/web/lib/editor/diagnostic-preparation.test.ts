import { expect, it } from "vitest";
import {
  cloneDiagnosticInput,
  prepareDiagnosticDisplay,
} from "./diagnostic-preparation";
import type { GraphDraftComposition } from "@k6flow/shared";

it("rejects metadata mismatch and unsupported inputs safely", () => {
  const graph: GraphDraftComposition = {
    version: 1,
    nodes: [{ id: "a", kind: "http-request", references: [] }],
    connections: [],
  };
  for (const nodeIds of [["b"], ["a", "a"], []]) {
    expect(() => prepareDiagnosticDisplay(graph, { nodeIds })).toThrow();
  }
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const input of [cycle, new Date(), () => {}, { value: Infinity }]) {
    expect(() => cloneDiagnosticInput(input)).toThrow();
  }
});

it("owns nested configuration without freezing or mutating caller data", () => {
  const input = { attachments: [{ id: "a", data: "payload" }] };
  const copy = cloneDiagnosticInput(input);
  copy.attachments[0].id = "b";
  expect(input.attachments[0].id).toBe("a");
  expect(Object.isFrozen(input)).toBe(false);
});
