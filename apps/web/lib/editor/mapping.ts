// K6F4-05a: Pure mapping between React Flow graph and GraphDraftComposition.
// No React, no side effects — just data transformation.
// The editor (05b) consumes these; config panels (05c) edit node.data.parameters.

import type { Node, Edge } from "@xyflow/react";
import type { GraphDraftComposition } from "@k6flow/shared";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type NodeKind = "authentication" | "http-request" | "response-validation" | "user-pool";

export interface K6NodeData {
  kind: NodeKind;
  label: string;
  references: { producerNodeId: string; output: string }[];
  parameters?: unknown;
  [key: string]: unknown; // Required for @xyflow/react Node<T> constraint
}

export type K6Node = Node<K6NodeData>;
export type K6Edge = Edge;

// Default labels for each node kind
const NODE_LABELS: Record<NodeKind, string> = {
  "authentication": "Authentication",
  "http-request": "HTTP Request",
  "response-validation": "Response Validation",
  "user-pool": "User Pool",
};

// -----------------------------------------------------------------------------
// GraphDraftComposition → React Flow
// -----------------------------------------------------------------------------

const NODE_SPACING_X = 250;
const NODE_SPACING_Y = 150;
const INITIAL_X = 100;
const INITIAL_Y = 100;

/**
 * Convert a GraphDraftComposition to React Flow nodes and edges.
 * Positions are computed in a simple left-to-right layout based on connection order.
 */
export function toReactFlowGraph(composition: GraphDraftComposition): {
  nodes: K6Node[];
  edges: K6Edge[];
} {
  // Build adjacency for topological position computation
  const outgoing = new Map<string, string>();
  for (const conn of composition.connections) {
    outgoing.set(conn.source, conn.target);
  }

  // Find root nodes (no incoming connections)
  const hasIncoming = new Set(composition.connections.map((c) => c.target));
  const roots = composition.nodes.filter((n) => !hasIncoming.has(n.id));

  // Compute positions via BFS from roots
  const positions = new Map<string, { x: number; y: number }>();
  let currentY = INITIAL_Y;

  for (const root of roots) {
    let currentX = INITIAL_X;
    let nodeId: string | undefined = root.id;

    while (nodeId && !positions.has(nodeId)) {
      positions.set(nodeId, { x: currentX, y: currentY });
      currentX += NODE_SPACING_X;
      nodeId = outgoing.get(nodeId);
    }

    currentY += NODE_SPACING_Y;
  }

  // Handle any disconnected nodes
  for (const node of composition.nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, { x: INITIAL_X, y: currentY });
      currentY += NODE_SPACING_Y;
    }
  }

  const nodes: K6Node[] = composition.nodes.map((node) => ({
    id: node.id,
    type: "k6Node",
    position: positions.get(node.id) ?? { x: INITIAL_X, y: INITIAL_Y },
    data: {
      kind: node.kind,
      label: NODE_LABELS[node.kind],
      references: node.references,
      parameters: node.parameters,
    },
  }));

  const edges: K6Edge[] = composition.connections.map((conn, index) => ({
    id: `edge-${index}`,
    source: conn.source,
    target: conn.target,
  }));

  return { nodes, edges };
}

// -----------------------------------------------------------------------------
// React Flow → GraphDraftComposition
// -----------------------------------------------------------------------------

/**
 * Convert React Flow nodes and edges back to a GraphDraftComposition.
 * Does NOT validate — caller should validate with graphDraftCompositionSchema.
 */
export function fromReactFlowGraph(
  nodes: K6Node[],
  edges: K6Edge[],
  load?: GraphDraftComposition["load"],
): GraphDraftComposition {
  // Cast nodes to the expected discriminated union type.
  // The caller should validate with graphDraftCompositionSchema after conversion.
  const mappedNodes = nodes.map((node) => {
    const base = {
      id: node.id,
      kind: node.data.kind,
      references: node.data.references,
    };
    return node.data.parameters !== undefined
      ? { ...base, parameters: node.data.parameters }
      : base;
  }) as GraphDraftComposition["nodes"];

  return {
    version: 1,
    nodes: mappedNodes,
    connections: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
    })),
    ...(load !== undefined && { load }),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let nodeIdCounter = 0;

/**
 * Generate a unique node ID.
 */
export function generateNodeId(): string {
  nodeIdCounter += 1;
  return `node-${Date.now()}-${nodeIdCounter}`;
}

/**
 * Reset the node ID counter (for testing).
 */
export function resetNodeIdCounter(): void {
  nodeIdCounter = 0;
}

/**
 * Create a new node with default values.
 */
export function createNode(kind: NodeKind, position: { x: number; y: number }): K6Node {
  return {
    id: generateNodeId(),
    type: "k6Node",
    position,
    data: {
      kind,
      label: NODE_LABELS[kind],
      references: [],
      parameters: undefined,
    },
  };
}

/**
 * Generate an edge ID from source and target.
 */
export function generateEdgeId(source: string, target: string): string {
  return `edge-${source}-${target}`;
}

/**
 * Get the label for a node kind.
 */
export function getNodeLabel(kind: NodeKind): string {
  return NODE_LABELS[kind];
}

/**
 * All available node kinds for the palette.
 */
export const NODE_KINDS: readonly NodeKind[] = [
  "authentication",
  "http-request",
  "response-validation",
  "user-pool",
] as const;
