import { z } from "zod";
import { CONTRACT_VERSION } from "./version";

const identifier = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a nonblank identifier",
});

// Editor-only metadata. Optional so graphs saved before it existed keep
// parsing unchanged; absent label/position/disabled mean default label,
// computed layout and enabled.
const MAX_NODE_LABEL_LENGTH = 120;
const nodeLabelSchema = z.string().max(MAX_NODE_LABEL_LENGTH)
  .refine((value) => value.trim().length > 0, { message: "Expected a nonblank label" });
const nodePositionSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

// Wait between two requests, configured on the connection and emitted as
// sleep() in the k6 script. Persisted in seconds; absent means no wait, so
// graphs saved before it existed keep translating unchanged.
const MAX_CONNECTION_WAIT_SECONDS = 3600;
const connectionWaitSchema = z.number().finite()
  .min(0, { message: "Expected a wait of at least 0 seconds" })
  .max(MAX_CONNECTION_WAIT_SECONDS, { message: "Expected a wait of at most 3600 seconds" });

const graphStructureShape = z.strictObject({
  version: z.literal(CONTRACT_VERSION),
  nodes: z.array(z.strictObject({
    id: identifier,
    kind: z.enum(["authentication", "http-request", "response-validation", "user-pool"]),
    references: z.array(z.strictObject({ producerNodeId: identifier, output: identifier })),
    label: nodeLabelSchema.optional(),
    position: nodePositionSchema.optional(),
    disabled: z.boolean().optional(),
  })),
  connections: z.array(z.strictObject({
    source: identifier,
    target: identifier,
    waitSeconds: connectionWaitSchema.optional(),
  })),
});

export type GraphDraftStructure = z.infer<typeof graphStructureShape>;

function validateDraft(graph: GraphDraftStructure, ctx: z.RefinementCtx): boolean {
  let valid = true;
  const issue = (path: (string | number)[], message: string) => {
    valid = false;
    ctx.addIssue({ code: "custom", path, message });
  };
  const ids = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (ids.has(node.id)) issue(["nodes", index, "id"], "Duplicate node identifier");
    ids.add(node.id);
  });
  const edges = new Map<string, Set<string>>();
  graph.connections.forEach((connection, index) => {
    for (const endpoint of ["source", "target"] as const) {
      if (!ids.has(connection[endpoint])) {
        issue(["connections", index, endpoint], "Unknown connection endpoint");
      }
    }
    const targets = edges.get(connection.source) ?? new Set<string>();
    if (targets.has(connection.target)) {
      issue(["connections", index], "Duplicate directed connection");
    }
    targets.add(connection.target);
    edges.set(connection.source, targets);
  });
  graph.nodes.forEach((node, index) => {
    node.references.forEach((reference, referenceIndex) => {
      if (!ids.has(reference.producerNodeId)) {
        issue(["nodes", index, "references", referenceIndex, "producerNodeId"],
          "Unknown reference producer");
      }
    });
  });
  return valid;
}

// Drafts preserve incomplete topology, but never dangling identities.
export const graphDraftStructureSchema = graphStructureShape.superRefine((graph, ctx) => {
  validateDraft(graph, ctx);
});

// Topology only: parameters, load configuration and output support remain unchecked.
export const graphExecutionTopologySchema = graphStructureShape.superRefine((graph, ctx) => {
  if (!validateDraft(graph, ctx)) return;
  const topologyIssue = () => ctx.addIssue({
    code: "custom", path: ["connections"],
    message: "Expected one nonempty connected linear chain without forks, merges or cycles",
  });
  if (graph.nodes.length === 0) {
    topologyIssue();
    return;
  }
  const next = new Map<string, string>();
  const incoming = new Set<string>();
  for (const { source, target } of graph.connections) {
    if (next.has(source) || incoming.has(target)) {
      topologyIssue();
      return;
    }
    next.set(source, target);
    incoming.add(target);
  }
  const heads = graph.nodes.filter((node) => !incoming.has(node.id));
  if (heads.length !== 1) {
    topologyIssue();
    return;
  }
  const order = new Map<string, number>();
  let current: string | undefined = heads[0]?.id;
  while (current !== undefined && !order.has(current)) {
    order.set(current, order.size);
    current = next.get(current);
  }
  if (current !== undefined || order.size !== graph.nodes.length) {
    topologyIssue();
    return;
  }
  // Disabled nodes stay in the saved chain; execution bypasses them, so the
  // effective chain is the traversal order minus disabled nodes.
  const disabled = new Set(graph.nodes.filter((node) => node.disabled === true).map((node) => node.id));
  if (disabled.size === graph.nodes.length) {
    ctx.addIssue({ code: "custom", path: ["nodes"], message: "Expected at least one enabled node" });
    return;
  }
  graph.nodes.forEach((node, index) => {
    node.references.forEach((reference, referenceIndex) => {
      if (node.disabled !== true && disabled.has(reference.producerNodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "references", referenceIndex, "producerNodeId"],
          message: "Reference producer is disabled",
        });
      }
      // Structural validation and complete traversal guarantee both ranks exist.
      const producerRank = order.get(reference.producerNodeId)!;
      const consumerRank = order.get(node.id)!;
      if (producerRank >= consumerRank) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "references", referenceIndex, "producerNodeId"],
          message: "Reference producer must precede its consumer in connection traversal",
        });
      }
    });
  });
});
export type GraphExecutionTopology = z.infer<typeof graphExecutionTopologySchema>;
