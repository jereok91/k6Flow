import { describe, expect, it } from "vitest";
import { createNode } from "./mapping";
import { snapshot, SaveBaseline } from "./save-state";

describe("save baseline", () => {
  it("excludes selection/transients but includes persisted graph and normalized load", () => {
    const node = createNode("http-request", { x: 1, y: 2 });
    const original = snapshot("name", [node], [], 1, "1m");
    expect(snapshot("name", [{ ...node, selected: true, dragging: true, measured: { width: 90 } }], [], 1, "60s")).toBe(original);
    expect(snapshot("name", [{ ...node, position: { x: 2, y: 2 } }], [], 1, "60s")).not.toBe(original);
    expect(snapshot("other", [node], [], 1, "60s")).not.toBe(original);
    expect(snapshot("name", [node], [], 2, "60s")).not.toBe(original);
    expect(snapshot("name", [{ ...node, data: { ...node.data, disabled: true } }], [], 1, "60s")).not.toBe(original);
    expect(snapshot("name", [{ ...node, data: { ...node.data, parameters: { method: "POST" } } }], [], 1, "60s")).not.toBe(original);
    const edge = { id: "edge", source: node.id, target: "other" };
    expect(snapshot("name", [node], [edge], 1, "60s")).toBe(snapshot("name", [node], [{ ...edge, selected: true }], 1, "1m"));
    expect(snapshot("name", [node], [edge], 1, "60s")).not.toBe(original);
  });
  it("keeps edits made during save dirty and rejects replaced-flow completions", () => {
    const baseline = new SaveBaseline("old");
    const ticket = baseline.submit("submitted");
    expect(baseline.accept(ticket)).toBe(true);
    expect(baseline.dirty("edited during await")).toBe(true);
    const stale = baseline.submit("stale");
    baseline.reset("new flow");
    expect(baseline.accept(stale)).toBe(false);
    expect(baseline.dirty("new flow")).toBe(false);
  });
});
