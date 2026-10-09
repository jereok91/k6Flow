import { describe, expect, expectTypeOf, it } from "vitest";
import { graphDraftStructureSchema, graphExecutionTopologySchema } from "./index";
import type { GraphDraftStructure, GraphExecutionTopology } from "./index";

const node = (id: string): GraphDraftStructure["nodes"][number] => ({
  id, kind: "http-request", references: [],
});
const edge = (source: string, target: string) => ({ source, target });
const graph = (
  nodes = [node("a"), node("b")],
  connections = [edge("a", "b")],
): GraphDraftStructure => ({ version: 1, nodes, connections });
const reference = (producerNodeId: string, output = "opaque-result") => ({ producerNodeId, output });

// Deliberately unsorted: traversal is pool -> auth -> request -> check.
const allKinds: GraphDraftStructure = graph([
  { id: "check", kind: "response-validation", references: [reference("request")] },
  { id: "request", kind: "http-request", references: [reference("auth")] },
  { id: "pool", kind: "user-pool", references: [] },
  { id: "auth", kind: "authentication", references: [reference("pool")] },
], [edge("request", "check"), edge("pool", "auth"), edge("auth", "request")]);

describe("graph structure and execution topology", () => {
  it("retains disconnected drafts but rejects disconnected execution topology", () => {
    const input = graph([node("a"), node("b")], []);
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(true);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(false);
  });

  it("accepts all four kinds in connection order without mutating array order", () => {
    const before = JSON.stringify(allKinds);
    expect(graphExecutionTopologySchema.parse(allKinds)).toEqual(allKinds);
    expect(graphDraftStructureSchema.parse(allKinds)).toEqual(allKinds);
    expect(JSON.stringify(allKinds)).toBe(before);
  });

  it("accepts a single node without references", () => {
    expect(graphExecutionTopologySchema.safeParse(graph([node("a")], [])).success).toBe(true);
  });

  it("retains an empty draft but rejects empty execution topology", () => {
    expect(graphDraftStructureSchema.safeParse(graph([], [])).success).toBe(true);
    expect(graphExecutionTopologySchema.safeParse(graph([], [])).success).toBe(false);
  });

  it.each([
    ["cycle", graph(undefined, [edge("a", "b"), edge("b", "a")])],
    ["self loop", graph([node("a")], [edge("a", "a")])],
    ["fork", graph([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")])],
    ["merge", graph([node("a"), node("b"), node("c")], [edge("a", "c"), edge("b", "c")])],
    ["chain plus isolated node", graph([node("a"), node("b"), node("c")])],
    ["chain plus disconnected cycle", graph([node("a"), node("b"), node("c"), node("d")],
      [edge("a", "b"), edge("c", "d"), edge("d", "c")])],
  ])("retains %s as a draft, not execution topology", (_name, input) => {
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(true);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(false);
  });

  it.each(["a", "b"])("rejects self/later producer %s for node a only in topology", (producer) => {
    const input = graph([{ ...node("a"), references: [reference(producer)] }, node("b")]);
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(true);
    const first = graphExecutionTopologySchema.safeParse(input);
    const second = graphExecutionTopologySchema.safeParse(input);
    expect(first.success).toBe(false);
    if (!first.success && !second.success) {
      expect(first.error.issues).toEqual(second.error.issues);
      expect(first.error.issues[0]?.path).toEqual(["nodes", 0, "references", 0, "producerNodeId"]);
    }
  });

  it.each([
    ["duplicate node", graph([node("a"), node("a")], [])],
    ["unknown source", graph(undefined, [edge("missing", "b")])],
    ["unknown target", graph(undefined, [edge("a", "missing")])],
    ["dangling producer", graph([{ ...node("a"), references: [reference("missing")] }], [])],
    ["duplicate connection", graph(undefined, [edge("a", "b"), edge("a", "b")])],
  ])("rejects %s even in drafts", (_name, input) => {
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(false);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["unsupported version", { ...graph(), version: 2 }],
    ["string version", { ...graph(), version: "1" }],
    ["missing version", { nodes: [], connections: [] }],
    ["unknown graph field", { ...graph(), params: {} }],
    ["missing connections", { version: 1, nodes: [] }],
    ["nonarray nodes", { ...graph(), nodes: {} }],
    ["blank node id", graph([node(" \t")], [])],
    ["numeric node id", { ...graph(), nodes: [{ ...node("a"), id: 1 }] }],
    ["unsupported kind", { ...graph(), nodes: [{ ...node("a"), kind: "branch" }] }],
    ["unknown node field", { ...graph(), nodes: [{ ...node("a"), params: {} }] }],
    ["missing references", { ...graph(), nodes: [{ id: "a", kind: "http-request" }] }],
    ["nonarray references", { ...graph(), nodes: [{ ...node("a"), references: {} }] }],
    ["blank output", graph([{ ...node("a"), references: [reference("a", " ")] }], [])],
    ["blank producer", graph([{ ...node("a"), references: [reference("")] }], [])],
    ["malformed reference", { ...graph(), nodes: [{ ...node("a"), references: [{ producerNodeId: "a" }] }] }],
    ["unknown reference field", { ...graph(), nodes: [{ ...node("a"), references: [{ ...reference("a"), template: "x" }] }] }],
    ["blank endpoint", graph(undefined, [edge("", "b")])],
    ["missing endpoint", { ...graph(), connections: [{ source: "a" }] }],
    ["unknown connection field", { ...graph(), connections: [{ ...edge("a", "b"), id: "edge" }] }],
    ["null envelope", null],
  ])("rejects malformed shape: %s", (_name, input) => {
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(false);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(false);
  });

  it("treats output names as opaque and identities as exact strings", () => {
    const input = graph([node("__proto__"), {
      ...node("constructor"), references: [reference("__proto__", "not-a-supported-output")],
    }], [edge("__proto__", "constructor")]);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(true);
    input.nodes[1]!.references[0]!.producerNodeId = " __proto__";
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(false);
  });

  it("validates a long chain iteratively", () => {
    const nodes = Array.from({ length: 12_000 }, (_, index) => node(String(index)));
    const connections = nodes.slice(1).map((item, index) => edge(String(index), item.id));
    expect(graphExecutionTopologySchema.safeParse(graph(nodes.reverse(), connections)).success).toBe(true);
  });

  it("exports schema-inferred structural types without execution-readiness branding", () => {
    expectTypeOf<GraphDraftStructure["version"]>().toEqualTypeOf<1>();
    expectTypeOf<GraphDraftStructure["nodes"][number]["kind"]>().toEqualTypeOf<
      "authentication" | "http-request" | "response-validation" | "user-pool"
    >();
    expectTypeOf<GraphDraftStructure["nodes"][number]["references"][number]>()
      .toEqualTypeOf<{ producerNodeId: string; output: string }>();
    expectTypeOf<GraphExecutionTopology>().toEqualTypeOf<GraphDraftStructure>();
  });
});

describe("editor metadata and disabled nodes", () => {
  const withMeta = (id: string, meta: Record<string, unknown>) => ({ ...node(id), ...meta });

  it("accepts old graphs without metadata unchanged", () => {
    expect(graphDraftStructureSchema.parse(allKinds)).toEqual(allKinds);
    expect(graphExecutionTopologySchema.safeParse(allKinds).success).toBe(true);
  });

  it("accepts optional label, position and disabled metadata", () => {
    const input = graph([
      withMeta("a", { label: "Login", position: { x: 10.5, y: -20 }, disabled: false }),
      withMeta("b", { disabled: true }),
    ]);
    expect(graphDraftStructureSchema.parse(input)).toEqual(input);
  });

  it.each([
    ["blank label", { label: "  " }],
    ["numeric label", { label: 3 }],
    ["overlong label", { label: "x".repeat(121) }],
    ["infinite position", { position: { x: Infinity, y: 0 } }],
    ["partial position", { position: { x: 1 } }],
    ["extra position field", { position: { x: 1, y: 2, z: 3 } }],
    ["string disabled", { disabled: "yes" }],
  ])("rejects malformed metadata: %s", (_name, meta) => {
    expect(graphDraftStructureSchema.safeParse(graph([withMeta("a", meta)], [])).success).toBe(false);
  });

  it("bypasses a disabled middle node in execution topology", () => {
    const input = graph([node("a"), withMeta("b", { disabled: true }), node("c")],
      [edge("a", "b"), edge("b", "c")]);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(true);
  });

  it("keeps a disabled dependency as draft but rejects it in execution topology", () => {
    const input = graph([withMeta("a", { disabled: true }),
      { ...node("b"), references: [reference("a")] }]);
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(true);
    const result = graphExecutionTopologySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([expect.objectContaining({
        path: ["nodes", 1, "references", 0, "producerNodeId"],
        message: "Reference producer is disabled",
      })]);
    }
  });

  it("allows a disabled consumer of a disabled producer", () => {
    const input = graph([node("a"), withMeta("b", { disabled: true }),
      { ...withMeta("c", { disabled: true }), references: [reference("b")] }],
    [edge("a", "b"), edge("b", "c")]);
    expect(graphExecutionTopologySchema.safeParse(input).success).toBe(true);
  });

  it("rejects execution topology when every node is disabled", () => {
    const input = graph([withMeta("a", { disabled: true })], []);
    expect(graphDraftStructureSchema.safeParse(input).success).toBe(true);
    const result = graphExecutionTopologySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("Expected at least one enabled node");
  });
});
