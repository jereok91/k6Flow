import { describe, expect, it, beforeEach } from "vitest";
import type { GraphDraftComposition } from "@k6flow/shared";
import {
  toReactFlowGraph,
  fromReactFlowGraph,
  generateNodeId,
  resetNodeIdCounter,
  createNode,
  generateEdgeId,
  getNodeLabel,
  NODE_KINDS,
  type K6Node,
  type K6Edge,
} from "./mapping";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const emptyGraph: GraphDraftComposition = {
  version: 1,
  nodes: [],
  connections: [],
};

const singleNodeGraph: GraphDraftComposition = {
  version: 1,
  nodes: [
    {
      id: "node-1",
      kind: "http-request",
      references: [],
      parameters: {
        method: "GET",
        url: { kind: "literal", value: "https://example.com" },
      },
    },
  ],
  connections: [],
};

const linearChainGraph: GraphDraftComposition = {
  version: 1,
  nodes: [
    { id: "auth", kind: "authentication", references: [] },
    { id: "http", kind: "http-request", references: [] },
    { id: "check", kind: "response-validation", references: [{ producerNodeId: "http", output: "response" }] },
  ],
  connections: [
    { source: "auth", target: "http" },
    { source: "http", target: "check" },
  ],
};

const disconnectedGraph: GraphDraftComposition = {
  version: 1,
  nodes: [
    { id: "pool", kind: "user-pool", references: [] },
    { id: "http", kind: "http-request", references: [] },
  ],
  connections: [],
};

// -----------------------------------------------------------------------------
// toReactFlowGraph
// -----------------------------------------------------------------------------

describe("toReactFlowGraph", () => {
  it("converts empty graph", () => {
    const { nodes, edges } = toReactFlowGraph(emptyGraph);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("converts single node graph", () => {
    const { nodes, edges } = toReactFlowGraph(singleNodeGraph);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);

    const node = nodes[0];
    expect(node.id).toBe("node-1");
    expect(node.type).toBe("k6Node");
    expect(node.data.kind).toBe("http-request");
    expect(node.data.label).toBe("HTTP Request");
    expect(node.data.parameters).toEqual({
      method: "GET",
      url: { kind: "literal", value: "https://example.com" },
    });
  });

  it("converts linear chain with correct positions", () => {
    const { nodes, edges } = toReactFlowGraph(linearChainGraph);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);

    // Nodes should be positioned left-to-right
    const authNode = nodes.find((n) => n.id === "auth")!;
    const httpNode = nodes.find((n) => n.id === "http")!;
    const checkNode = nodes.find((n) => n.id === "check")!;

    expect(authNode.position.x).toBeLessThan(httpNode.position.x);
    expect(httpNode.position.x).toBeLessThan(checkNode.position.x);
  });

  it("preserves references in node data", () => {
    const { nodes } = toReactFlowGraph(linearChainGraph);
    const checkNode = nodes.find((n) => n.id === "check")!;

    expect(checkNode.data.references).toEqual([
      { producerNodeId: "http", output: "response" },
    ]);
  });

  it("handles disconnected nodes", () => {
    const { nodes } = toReactFlowGraph(disconnectedGraph);
    expect(nodes).toHaveLength(2);

    // Both should have positions
    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("creates edge IDs", () => {
    const { edges } = toReactFlowGraph(linearChainGraph);
    expect(edges[0].id).toBe("edge-0");
    expect(edges[1].id).toBe("edge-1");
  });
});

// -----------------------------------------------------------------------------
// fromReactFlowGraph
// -----------------------------------------------------------------------------

describe("fromReactFlowGraph", () => {
  it("converts empty graph", () => {
    const result = fromReactFlowGraph([], []);
    expect(result).toEqual({
      version: 1,
      nodes: [],
      connections: [],
    });
  });

  it("converts nodes back to composition format", () => {
    const nodes: K6Node[] = [
      {
        id: "node-1",
        type: "k6Node",
        position: { x: 100, y: 100 },
        data: {
          kind: "http-request",
          label: "HTTP Request",
          references: [],
          parameters: { method: "POST", url: { kind: "literal", value: "https://api.test" } },
        },
      },
    ];

    const result = fromReactFlowGraph(nodes, []);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toEqual({
      id: "node-1",
      kind: "http-request",
      references: [],
      position: { x: 100, y: 100 },
      parameters: { method: "POST", url: { kind: "literal", value: "https://api.test" } },
    });
  });

  it("converts edges back to connections", () => {
    const edges: K6Edge[] = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ];

    const result = fromReactFlowGraph([], edges);

    expect(result.connections).toEqual([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);
  });

  it("omits parameters when undefined", () => {
    const nodes: K6Node[] = [
      {
        id: "node-1",
        type: "k6Node",
        position: { x: 0, y: 0 },
        data: {
          kind: "authentication",
          label: "Authentication",
          references: [],
          parameters: undefined,
        },
      },
    ];

    const result = fromReactFlowGraph(nodes, []);
    expect("parameters" in result.nodes[0]).toBe(false);
  });

  it("includes load when provided", () => {
    const load = {
      version: 1 as const,
      profile: { kind: "constant-vus" as const, vus: 10, durationMs: 30000 },
      thresholds: [],
      thresholdPolicy: "final-pass-fail" as const,
    };

    const result = fromReactFlowGraph([], [], load);
    expect(result.load).toEqual(load);
  });

  it("omits load when undefined", () => {
    const result = fromReactFlowGraph([], []);
    expect("load" in result).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Round-trip
// -----------------------------------------------------------------------------

describe("round-trip", () => {
  it("preserves data through conversion cycle", () => {
    const { nodes, edges } = toReactFlowGraph(linearChainGraph);
    const result = fromReactFlowGraph(nodes, edges);

    // Version and structure should match
    expect(result.version).toBe(linearChainGraph.version);
    expect(result.nodes).toHaveLength(linearChainGraph.nodes.length);
    expect(result.connections).toHaveLength(linearChainGraph.connections.length);

    // Node data should match (order may differ)
    for (const originalNode of linearChainGraph.nodes) {
      const roundTripped = result.nodes.find((n) => n.id === originalNode.id);
      expect(roundTripped).toBeDefined();
      expect(roundTripped!.kind).toBe(originalNode.kind);
      expect(roundTripped!.references).toEqual(originalNode.references);
    }

    // Connections should match
    expect(result.connections).toEqual(linearChainGraph.connections);
  });

  it("preserves parameters through conversion", () => {
    const { nodes, edges } = toReactFlowGraph(singleNodeGraph);
    const result = fromReactFlowGraph(nodes, edges);

    expect(result.nodes[0].parameters).toEqual(singleNodeGraph.nodes[0].parameters);
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

describe("generateNodeId", () => {
  beforeEach(() => {
    resetNodeIdCounter();
  });

  it("generates unique IDs", () => {
    const id1 = generateNodeId();
    const id2 = generateNodeId();
    expect(id1).not.toBe(id2);
  });

  it("includes timestamp component", () => {
    const id = generateNodeId();
    expect(id).toMatch(/^node-\d+-\d+$/);
  });
});

describe("createNode", () => {
  beforeEach(() => {
    resetNodeIdCounter();
  });

  it("creates node with correct structure", () => {
    const node = createNode("http-request", { x: 200, y: 300 });

    expect(node.type).toBe("k6Node");
    expect(node.position).toEqual({ x: 200, y: 300 });
    expect(node.data.kind).toBe("http-request");
    expect(node.data.label).toBe("HTTP Request");
    expect(node.data.references).toEqual([]);
    expect(node.data.parameters).toBeUndefined();
  });

  it("creates each node kind with correct label", () => {
    for (const kind of NODE_KINDS) {
      const node = createNode(kind, { x: 0, y: 0 });
      expect(node.data.kind).toBe(kind);
      expect(node.data.label).toBe(getNodeLabel(kind));
    }
  });
});

describe("generateEdgeId", () => {
  it("creates deterministic edge ID", () => {
    const id = generateEdgeId("source-1", "target-2");
    expect(id).toBe("edge-source-1-target-2");
  });
});

describe("getNodeLabel", () => {
  it("returns correct labels", () => {
    expect(getNodeLabel("authentication")).toBe("Authentication");
    expect(getNodeLabel("http-request")).toBe("HTTP Request");
    expect(getNodeLabel("response-validation")).toBe("Response Validation");
    expect(getNodeLabel("user-pool")).toBe("User Pool");
  });
});

describe("NODE_KINDS", () => {
  it("contains all four kinds", () => {
    expect(NODE_KINDS).toEqual([
      "authentication",
      "http-request",
      "response-validation",
      "user-pool",
    ]);
  });

  it("is readonly", () => {
    // TypeScript should prevent modification, but we can check length
    expect(NODE_KINDS.length).toBe(4);
  });
});

// -----------------------------------------------------------------------------
// Editor metadata (label, position, disabled)
// -----------------------------------------------------------------------------

describe("editor metadata", () => {
  const metadataGraph: GraphDraftComposition = {
    version: 1,
    nodes: [
      { id: "auth", kind: "authentication", references: [], label: "Login",
        position: { x: 12, y: 34 } },
      { id: "http", kind: "http-request", references: [], disabled: true,
        position: { x: 400, y: -50 } },
    ],
    connections: [{ source: "auth", target: "http" }],
  };

  it("defaults labels, computed layout and enabled state for old graphs", () => {
    const { nodes } = toReactFlowGraph(linearChainGraph);
    expect(nodes.map((n) => n.data.label)).toEqual(["Authentication", "HTTP Request", "Response Validation"]);
    expect(nodes.map((n) => n.data.disabled)).toEqual([false, false, false]);
    expect(nodes[0].position).toEqual({ x: 100, y: 100 });
  });

  it("loads stored labels, positions and disabled flags", () => {
    const { nodes } = toReactFlowGraph(metadataGraph);
    expect(nodes[0].data.label).toBe("Login");
    expect(nodes[0].position).toEqual({ x: 12, y: 34 });
    expect(nodes[0].data.disabled).toBe(false);
    expect(nodes[1].data.label).toBe("HTTP Request");
    expect(nodes[1].position).toEqual({ x: 400, y: -50 });
    expect(nodes[1].data.disabled).toBe(true);
  });

  it("round-trips metadata, omitting default labels and enabled flags", () => {
    const { nodes, edges } = toReactFlowGraph(metadataGraph);
    expect(fromReactFlowGraph(nodes, edges)).toEqual(metadataGraph);
  });

  it("persists computed positions for old graphs so the layout is stable", () => {
    const { nodes, edges } = toReactFlowGraph(linearChainGraph);
    const saved = fromReactFlowGraph(nodes, edges);
    expect(saved.nodes.map((n) => n.position)).toEqual(nodes.map((n) => n.position));
    expect(saved.nodes.every((n) => !("label" in n) && !("disabled" in n))).toBe(true);
  });

  it("omits blank labels and trims custom labels on save", () => {
    const [blank] = toReactFlowGraph(singleNodeGraph).nodes;
    blank.data.label = "   ";
    expect("label" in fromReactFlowGraph([blank], []).nodes[0]).toBe(false);
    blank.data.label = "  Users API  ";
    expect(fromReactFlowGraph([blank], []).nodes[0].label).toBe("Users API");
  });

  it("creates new nodes enabled", () => {
    expect(createNode("user-pool", { x: 0, y: 0 }).data.disabled).toBe(false);
  });
});
