import { z } from "zod";
import { graphDraftStructureSchema, graphExecutionTopologySchema } from "./graph";
import { httpParametersSchema } from "./http-parameters";
import type { HttpParameters } from "./http-parameters";
import { authParametersSchema } from "./auth-parameters";
import { checkParametersSchema } from "./check-parameters";
import { csvPoolParametersSchema } from "./csv-pool-parameters";
import { loadParametersSchema } from "./load-parameters";
import type {
  JsonParameterValue, ProducerOutputReference, StringParameterValue,
} from "./parameter-values";

// Composition is additive: structural identities, topology and parameter
// schemas are reused unchanged. Declaration/validation only, never resolution.
const structural = graphDraftStructureSchema.shape;
const nodeShape = structural.nodes.element.shape;

const draftNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: nodeShape.id, kind: z.literal("authentication"),
    references: nodeShape.references, parameters: authParametersSchema.optional() }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("http-request"),
    references: nodeShape.references, parameters: httpParametersSchema.optional() }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("response-validation"),
    references: nodeShape.references, parameters: checkParametersSchema.optional() }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("user-pool"),
    references: nodeShape.references, parameters: csvPoolParametersSchema.optional() }),
]);
const readyNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: nodeShape.id, kind: z.literal("authentication"),
    references: nodeShape.references, parameters: authParametersSchema }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("http-request"),
    references: nodeShape.references, parameters: httpParametersSchema }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("response-validation"),
    references: nodeShape.references, parameters: checkParametersSchema }),
  z.strictObject({ id: nodeShape.id, kind: z.literal("user-pool"),
    references: nodeShape.references, parameters: csvPoolParametersSchema }),
]);
type TypedDraftNode = z.infer<typeof draftNodeSchema>;

type OutputType = "string" | "json" | "http-response";
type EmbeddedReference = { reference: ProducerOutputReference; slot: OutputType };
const referenceKey = (reference: ProducerOutputReference) =>
  JSON.stringify([reference.producerNodeId, reference.output]);

// Inspect only supported slots; reference-shaped literal data stays data.
function httpSlotReferences(parameters: HttpParameters): EmbeddedReference[] {
  const embedded: EmbeddedReference[] = [];
  const inspect = (
    value: StringParameterValue | JsonParameterValue, slot: EmbeddedReference["slot"],
  ) => {
    if (value.kind === "reference") embedded.push({ reference: value.reference, slot });
  };
  inspect(parameters.url, "string");
  for (const entry of parameters.headers ?? []) inspect(entry.value, "string");
  for (const entry of parameters.query ?? []) inspect(entry.value, "string");
  if (parameters.body?.kind === "text") inspect(parameters.body.value, "string");
  if (parameters.body?.kind === "json") inspect(parameters.body.value, "json");
  return embedded;
}

function embeddedReferences(node: TypedDraftNode): EmbeddedReference[] {
  switch (node.kind) {
    case "http-request":
      return node.parameters === undefined ? [] : httpSlotReferences(node.parameters);
    case "authentication":
      return node.parameters?.method.kind === "http"
        ? httpSlotReferences(node.parameters.method.request) : [];
    case "response-validation":
      return node.parameters === undefined
        ? [] : [{ reference: node.parameters.response, slot: "http-response" }];
    case "user-pool":
      return [];
  }
}

// The built-in HTTP response exists even while draft parameters are omitted;
// checks nodes expose no consumable outputs at all.
function outputCatalog(node: TypedDraftNode): { name: string; type: OutputType }[] {
  switch (node.kind) {
    case "http-request":
      return [{ name: "response", type: "http-response" }];
    case "authentication":
      return node.parameters?.outputs.map((output) =>
        ({ name: output.name, type: output.expectedType })) ?? [];
    case "user-pool":
      return node.parameters?.outputs.map((output) =>
        ({ name: output.name, type: "string" as OutputType })) ?? [];
    case "response-validation":
      return [];
  }
}

// Strings supply string consumers and are JSON data; a general JSON output does
// not guarantee a string consumer; http-response feeds checks only.
function compatible(slot: OutputType, output: OutputType): boolean {
  if (slot === "http-response") return output === "http-response";
  if (output === "http-response") return false;
  return slot === "json" || output === "string";
}

type DraftGraph = {
  version: 1;
  nodes: TypedDraftNode[];
  connections: z.infer<typeof structural.connections>;
  load?: z.infer<typeof loadParametersSchema>;
};

// Producer precedence is intentionally not checked inside this function:
// the reconciliation below requires every embedded reference to be declared,
// and the ready path first forwards the graph to the reviewed
// graphExecutionTopologySchema, which rejects any producer that does not
// precede its consumer in connection traversal. Drafts omit precedence only
// because no linear rank exists while editing.
function validateComposition(graph: DraftGraph, ctx: z.RefinementCtx): void {
  const catalogs = new Map<string, Map<string, OutputType>>();
  graph.nodes.forEach((node, index) => {
    const outputs = new Map<string, OutputType>();
    outputCatalog(node).forEach((output, outputIndex) => {
      if (node.kind !== "http-request" && output.name === "response") {
        ctx.addIssue({ code: "custom",
          path: ["nodes", index, "parameters", "outputs", outputIndex, "name"],
          message: "The output name \"response\" is reserved for built-in HTTP responses" });
      }
      outputs.set(output.name, output.type);
    });
    catalogs.set(node.id, outputs);
  });
  graph.nodes.forEach((node, index) => {
    const declaredIndexByKey = new Map(
      node.references.map((reference, referenceIndex) =>
        [referenceKey(reference), referenceIndex] as const),
    );
    const declaredPath = (reference: ProducerOutputReference) => {
      const declaredIndex = declaredIndexByKey.get(referenceKey(reference));
      return ["nodes", index, "references", ...(declaredIndex === undefined ? [] : [declaredIndex])];
    };
    const embedded = embeddedReferences(node);
    const embeddedKeys = new Set(embedded.map((entry) => referenceKey(entry.reference)));
    node.references.forEach((reference, referenceIndex) => {
      if (!embeddedKeys.has(referenceKey(reference))) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "references", referenceIndex],
          message: "Declared reference is not embedded in the node's parameters" });
      }
    });
    embedded.forEach(({ reference, slot }) => {
      if (!declaredIndexByKey.has(referenceKey(reference))) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "references"],
          message: "Embedded parameter reference is not declared in the node's references" });
      }
      const outputType = catalogs.get(reference.producerNodeId)?.get(reference.output);
      if (outputType === undefined) {
        ctx.addIssue({ code: "custom", path: declaredPath(reference),
          message: "Reference target is not a supported producer output" });
      } else if (!compatible(slot, outputType)) {
        ctx.addIssue({ code: "custom", path: declaredPath(reference),
          message: "Producer output type is not compatible with the consuming slot" });
      }
    });
  });
}

// Structural identities/topology stay owned by the reviewed graph schemas;
// their custom issues are forwarded with identical paths and messages.
function forwardStructural(graph: DraftGraph, schema: z.ZodTypeAny, ctx: z.RefinementCtx): boolean {
  const result = schema.safeParse({
    version: graph.version,
    nodes: graph.nodes.map(({ id, kind, references }) => ({ id, kind, references })),
    connections: graph.connections,
  });
  if (result.success) return true;
  for (const issue of result.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
  return false;
}

const draftCompositionShape = z.strictObject({
  version: structural.version,
  nodes: z.array(draftNodeSchema),
  connections: structural.connections,
  load: loadParametersSchema.optional(),
});
const readyCompositionShape = z.strictObject({
  version: structural.version,
  nodes: z.array(readyNodeSchema),
  connections: structural.connections,
  load: loadParametersSchema,
});

// Drafts retain incomplete parameters and topology; reconciliation, reserved
// names, catalogs and slot compatibility still hold. Precedence is not
// enforceable while editing and is left to ready validation.
export const graphDraftCompositionSchema = draftCompositionShape.superRefine((graph, ctx) => {
  if (forwardStructural(graph, graphDraftStructureSchema, ctx)) validateComposition(graph, ctx);
});
export type GraphDraftComposition = z.infer<typeof graphDraftCompositionSchema>;

// Ready graphs add the reviewed linear topology (including producer
// precedence), required valid parameters on every node and a global load.
export const graphReadyCompositionSchema = readyCompositionShape.superRefine((graph, ctx) => {
  if (forwardStructural(graph, graphExecutionTopologySchema, ctx)) validateComposition(graph, ctx);
});
export type GraphReadyComposition = z.infer<typeof graphReadyCompositionSchema>;
