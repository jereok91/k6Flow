import {
  diagnosticMetadataSchema,
  type GraphDraftComposition,
} from "@k6flow/shared";

export interface ExecutionDisplayNode {
  readonly id: string;
  readonly kind: GraphDraftComposition["nodes"][number]["kind"];
  readonly label: string | undefined;
  readonly position: Readonly<{ x: number; y: number }> | undefined;
  readonly disabled: boolean;
}

export type ExecutionDisplay = readonly ExecutionDisplayNode[];

export interface OwnedDiagnosticMetadata {
  readonly nodeIds: readonly string[];
}

/** Only plain data is supported. Accessors, prototypes and cycles fail closed. */
export function cloneDiagnosticInput<T>(input: T): T {
  const active = new Set<object>();
  const clone = (value: unknown): unknown => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== "object" || active.has(value)) {
      throw new Error("Unsupported diagnostic input");
    }
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("Unsupported diagnostic input");
    }
    active.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new Error("Unsupported diagnostic input");
      }
      Object.defineProperty(result, key, {
        value: clone(descriptor.value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return clone(input) as T;
}

export function prepareDiagnosticDisplay(
  graph: GraphDraftComposition,
  metadata: unknown,
): { executionDisplay: ExecutionDisplay; diagnostic: OwnedDiagnosticMetadata } {
  const { nodeIds } = diagnosticMetadataSchema.parse(metadata);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (
    nodes.size !== graph.nodes.length ||
    nodes.size !== nodeIds.length ||
    nodeIds.some(id => !nodes.has(id))
  ) {
    throw new Error("Diagnostic metadata mismatch");
  }
  const executionDisplay = Object.freeze(
    nodeIds.map(id => {
      const node = nodes.get(id)!;
      return Object.freeze({
        id,
        kind: node.kind,
        label: node.label,
        position: node.position ? Object.freeze({ ...node.position }) : undefined,
        disabled: node.disabled === true,
      });
    }),
  );
  return {
    executionDisplay,
    diagnostic: Object.freeze({ nodeIds: Object.freeze([...nodeIds]) }),
  };
}
