import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FlowEditor, notifyNodesRemoved, removedNodeIds } from "./FlowEditor";
import { deleteSelection } from "./node-interactions";
import { createNode, type K6Edge, type K6Node } from "./mapping";
import { ThemeProvider } from "../theme/ThemeProvider";

// T7 follow-up: a deletion that actually removes nodes must notify the page once,
// with exactly the removed ids, so it can drop their endpoint-test results. This
// suite exercises the same reference-safe deleteSelection the editor uses and the
// exported notification helper at the point the new node list is accepted.

const ref = (id: string, output = "response") => ({ producerNodeId: id, output });

function fixture(): K6Node[] {
  const producer = { ...createNode("http-request", { x: 10, y: 20 }), id: "a", selected: false };
  const consumer = { ...createNode("response-validation", { x: 100, y: 80 }), id: "b", selected: false };
  consumer.data = { ...consumer.data, references: [ref("a")], parameters: { response: ref("a"), checks: [] } };
  return [producer, consumer];
}

const select = (nodes: K6Node[], ...ids: string[]): K6Node[] =>
  nodes.map(n => ({ ...n, selected: ids.includes(n.id) }));

describe("FlowEditor node removal notification", () => {
  it("reports exactly the ids a real deletion removed, once", () => {
    const nodes = select(fixture(), "a", "b");
    const edges: K6Edge[] = [{ id: "ab", source: "a", target: "b" }];
    const result = deleteSelection(nodes, edges);
    expect(result.error).toBeUndefined();
    const removed = vi.fn();
    notifyNodesRemoved(nodes, result.nodes, removed);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does not notify when a referenced-producer deletion is refused", () => {
    const nodes = select(fixture(), "a");
    const result = deleteSelection(nodes, [{ id: "ab", source: "a", target: "b" }]);
    expect(result.error).toMatch(/referencia/i);
    const removed = vi.fn();
    notifyNodesRemoved(nodes, result.nodes, removed);
    expect(removed).not.toHaveBeenCalled();
  });

  it("does not notify when nothing is selected to delete", () => {
    const nodes = fixture();
    const result = deleteSelection(nodes, []);
    expect(result.nodes).toHaveLength(nodes.length);
    const removed = vi.fn();
    notifyNodesRemoved(nodes, result.nodes, removed);
    expect(removed).not.toHaveBeenCalled();
  });

  it("returns removed ids in graph order and none when every node survives", () => {
    const nodes = fixture();
    expect(removedNodeIds(nodes, [nodes[0]])).toEqual(["b"]);
    expect(removedNodeIds(nodes, nodes)).toEqual([]);
  });

  it("is a no-op when no callback is wired", () => {
    const nodes = fixture();
    expect(() => notifyNodesRemoved(nodes, [nodes[0]], undefined)).not.toThrow();
  });

  it("still renders without the optional callback", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        null,
        createElement(FlowEditor, {
          nodes: fixture(),
          edges: [],
          flowSession: "s",
          onNodesChange() {},
          onEdgesChange() {},
        }),
      ),
    );
    expect(html).toContain("Lienzo del flujo");
  });
});
