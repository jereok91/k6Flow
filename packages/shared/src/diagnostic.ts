import { z } from "zod";

/** Application-generated custom metric protocol, not native k6 tracing. */
export const DIAGNOSTIC_METRIC = "k6flow_diagnostic_event";
export const DIAGNOSTIC_MAX_NODES = 100;
export const DIAGNOSTIC_MAX_EVENTS = 2 * DIAGNOSTIC_MAX_NODES + 1;
export const DIAGNOSTIC_TIMEOUT_MS = 30_000;
export const runModeSchema = z.enum(["load", "diagnostic"]);
export type RunMode = z.infer<typeof runModeSchema>;
// Opaque graph IDs only; bounded strings may include escaped punctuation.
export const diagnosticNodeIdSchema = z.string().min(1).max(128).refine(
  value => new TextEncoder().encode(value).length <= 128, { message: "Node ID exceeds 128 UTF-8 bytes" },
);
export const diagnosticMetadataSchema = z.strictObject({
  nodeIds: z.array(diagnosticNodeIdSchema).min(1).max(DIAGNOSTIC_MAX_NODES),
}).superRefine(({ nodeIds }, ctx) => {
  if (new Set(nodeIds).size !== nodeIds.length) ctx.addIssue({ code: "custom", message: "Duplicate node IDs" });
});
/** Decoded JSON-output Point: value is elapsed milliseconds; all tags are closed. */
export const diagnosticEventSchema = z.strictObject({
  seq: z.number().int().min(1).max(DIAGNOSTIC_MAX_EVENTS),
  nodeId: diagnosticNodeIdSchema.or(z.literal("")), // empty only for completion
  event: z.enum(["enter", "exit", "skipped", "complete"]),
  elapsedMs: z.number().finite().min(0).max(DIAGNOSTIC_TIMEOUT_MS),
  httpStatus: z.number().int().min(0).max(599), // zero means unavailable/not HTTP
  outcome: z.enum(["pending", "success", "failure", "skipped"]),
  reason: z.enum(["none", "disabled", "prior-failure", "http", "extraction", "check", "pool", "exception"]),
}).superRefine((event, ctx) => {
  if ((event.event === "complete") !== (event.nodeId === "")) {
    ctx.addIssue({ code: "custom", message: "Only completion has an empty node ID" });
  }
  const outcomes = { enter: ["pending"], exit: ["success", "failure"], skipped: ["skipped"], complete: ["success", "failure"] };
  if (!outcomes[event.event].includes(event.outcome)) ctx.addIssue({ code: "custom", message: "Invalid event outcome" });
  const validReason = event.event === "skipped" ? ["disabled", "prior-failure"].includes(event.reason)
    : event.outcome === "failure" ? (event.event === "complete" ? event.reason === "prior-failure"
      : ["http", "extraction", "check", "pool", "exception"].includes(event.reason))
    : event.reason === "none";
  if (!validReason) ctx.addIssue({ code: "custom", message: "Invalid event reason" });
  if (event.event !== "exit" && (event.elapsedMs !== 0 || event.httpStatus !== 0)) {
    ctx.addIssue({ code: "custom", message: "Only exit carries timing/status" });
  }
});
export type DiagnosticMetadata = z.infer<typeof diagnosticMetadataSchema>;
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

/** Init stays outside this helper; missing completion is reconciled by the server. */
export function diagnosticPrelude(): string[] {
  return [
    `const __diagMetric = new Counter(${JSON.stringify(DIAGNOSTIC_METRIC)});`,
    `function __diagEmit(nodeId, event, elapsedMs, httpStatus, outcome, reason) {`,
    `  __diagMetric.add(Math.min(${DIAGNOSTIC_TIMEOUT_MS}, Math.max(0, elapsedMs)), {`,
    `    seq: String(++__diagSeq), nodeId, event, httpStatus: String(httpStatus), outcome, reason,`,
    `  });`,
    `}`, // sequence state reset per iteration (diagnostic is exactly one)
    `let __diagSeq = 0;`,
  ];
}

/** Hoist node values so conditional execution does not hide downstream outputs. */
export function instrumentDiagnosticNode(
  lines: string[], nodeId: string, disabled: boolean, success: string[],
): string[] {
  const id = JSON.stringify(nodeId);
  if (disabled) return [`  __diagEmit(${id}, 'skipped', 0, 0, 'skipped', 'disabled');`];
  const declarations: string[] = [];
  const statements = lines.map(line => line.replace(/^(\s*)const ([A-Za-z0-9_]+) = /, (_, indent, name) => {
    declarations.push(`  let ${name};`);
    return `${indent}${name} = `;
  }));
  return [
    ...declarations,
    `  if (__diagFailed) {`,
    `    __diagEmit(${id}, 'skipped', 0, 0, 'skipped', 'prior-failure');`,
    `  } else {`,
    `    __diagEmit(${id}, 'enter', 0, 0, 'pending', 'none');`,
    `    const __diagStart = Date.now();`,
    `    let __diagReason = 'none', __diagStatus = 0;`,
    `    try {`,
    ...statements,
    ...success,
    `    } catch (_) { if (__diagReason === 'none') __diagReason = 'exception'; }`,
    `    __diagFailed = __diagReason !== 'none';`,
    `    __diagEmit(${id}, 'exit', Date.now() - __diagStart, __diagStatus, __diagFailed ? 'failure' : 'success', __diagReason);`,
    `  }`,
  ];
}
