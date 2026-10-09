import { z } from "zod";
import { versionEnvelopeSchema } from "./version";
import { diagnosticMetadataSchema, runModeSchema } from "./diagnostic";

const positiveSafeInteger = z.number().int().positive();
const nonnegativeSafeInteger = z.number().int().nonnegative();
const nonblankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a nonblank string",
});
const runEnvelope = versionEnvelopeSchema.shape.version;
// Declaration only: exact closed lifecycle set; summaries exist for terminal states.
export const runStatusSchema = z.enum(["pending", "running", "finished", "failed", "stopped"]);
export const runTerminalStatusSchema = z.enum(["finished", "failed", "stopped"]);
export const idempotencyKeySchema = nonblankString;
// k6flow-variables V-T3: secret variables travel as K6FLOW_VAR_* container env.
// Limits mirror the orchestrator (UTF-8 bytes): <= 100 entries, value <= 8 KiB,
// keys + values <= 64 KiB. Values are request-scoped: never stored, returned or logged.
export const RUN_ENV_KEY_PATTERN = /^K6FLOW_VAR_[A-Z0-9_]{1,80}$/;
export const RUN_ENV_MAX_ENTRIES = 100;
export const RUN_ENV_MAX_VALUE_BYTES = 8 * 1024;
export const RUN_ENV_MAX_TOTAL_BYTES = 64 * 1024;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
export const runEnvSchema = z.record(
  z.string().regex(RUN_ENV_KEY_PATTERN),
  z.string().refine((value) => utf8Bytes(value) <= RUN_ENV_MAX_VALUE_BYTES, {
    message: `Env value exceeds ${RUN_ENV_MAX_VALUE_BYTES} bytes`,
  }),
).superRefine((env, ctx) => {
  const entries = Object.entries(env);
  if (entries.length > RUN_ENV_MAX_ENTRIES) {
    ctx.addIssue({ code: "custom", message: `Env has more than ${RUN_ENV_MAX_ENTRIES} entries` });
  }
  const total = entries.reduce((sum, [key, value]) => sum + utf8Bytes(key) + utf8Bytes(value), 0);
  if (total > RUN_ENV_MAX_TOTAL_BYTES) {
    ctx.addIssue({ code: "custom", message: `Env exceeds ${RUN_ENV_MAX_TOTAL_BYTES} bytes in total` });
  }
});
// Opaque compiled script. Diagnostic metadata contains IDs/order only, never graph parameters.
// Runtime must enforce diagnostic options independently; load retains REST overrides.
export const runStartConfigSchema = z.strictObject({
  version: runEnvelope,
  script: nonblankString,
  mode: runModeSchema.default("load"),
  diagnostic: diagnosticMetadataSchema.optional(),
  vus: positiveSafeInteger,
  durationMs: positiveSafeInteger,
  cpuMillis: positiveSafeInteger,
  memoryMiB: positiveSafeInteger,
  attachments: z.array(z.strictObject({ id: nonblankString })).optional(),
  env: runEnvSchema.optional(),
}).superRefine((config, ctx) => {
  if ((config.mode === "diagnostic") !== (config.diagnostic !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["diagnostic"], message: "Diagnostic mode requires metadata; load forbids it" });
  }
});
export const runReferenceSchema = z.strictObject({ version: runEnvelope, runId: nonblankString });
export const runStateSchema = z.strictObject({
  version: runEnvelope, runId: nonblankString, status: runStatusSchema,
});
// Cumulative final summary only: windowed metrics belong to K6F1-05; thresholdsPassed is present exactly for finished runs.
export const runTotalsSchema = z.strictObject({
  requests: nonnegativeSafeInteger,
  errors: nonnegativeSafeInteger,
  failedChecks: nonnegativeSafeInteger,
});
export const runLatencySchema = z.strictObject({
  avgMs: z.number().finite().nonnegative(),
  p90Ms: z.number().finite().nonnegative(),
  p95Ms: z.number().finite().nonnegative(),
  p99Ms: z.number().finite().nonnegative(),
});
const summaryFields = {
  version: runEnvelope, runId: nonblankString, totals: runTotalsSchema, latency: runLatencySchema,
};
export const runSummarySchema = z.discriminatedUnion("status", [
  z.strictObject({ ...summaryFields, status: z.literal("finished"), thresholdsPassed: z.boolean() }),
  z.strictObject({ ...summaryFields, status: z.literal("failed") }),
  z.strictObject({ ...summaryFields, status: z.literal("stopped") }),
]);
// Exact error/status catalog: structured bodies are version, code and message only.
export const runErrorCodeSchema = z.enum(["unauthorized", "run-not-found", "summary-not-terminal"]);
export const runErrorCatalogSchema = z.strictObject({
  unauthorized: z.literal(401),
  "run-not-found": z.literal(404),
  "summary-not-terminal": z.literal(409),
});
export const runErrorResponseSchema = z.strictObject({
  version: runEnvelope, code: runErrorCodeSchema, message: nonblankString,
});
export type RunStartDedupeRecord = {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly body: RunStartConfig;
};
export type RunStartDedupeOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "deduplicated"; readonly runId: string };
const sameJson = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    Object.hasOwn(b, key) &&
    sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};
// Pure derivation over caller-supplied records: no store, handler or persistence.
export function deriveRunStartOutcome(
  recorded: readonly RunStartDedupeRecord[],
  request: { readonly idempotencyKey?: string; readonly body: RunStartConfig },
): RunStartDedupeOutcome {
  if (request.idempotencyKey === undefined) return { kind: "created" };
  const match = recorded.find((record) => record.idempotencyKey === request.idempotencyKey &&
    sameJson(record.body, request.body));
  return match === undefined ? { kind: "created" } : { kind: "deduplicated", runId: match.runId };
}
export type RunEnv = z.infer<typeof runEnvSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunTerminalStatus = z.infer<typeof runTerminalStatusSchema>;
export type RunStartConfig = z.input<typeof runStartConfigSchema>;
export type RunReference = z.infer<typeof runReferenceSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type RunTotals = z.infer<typeof runTotalsSchema>;
export type RunLatency = z.infer<typeof runLatencySchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunErrorCode = z.infer<typeof runErrorCodeSchema>;
export type RunErrorCatalog = z.infer<typeof runErrorCatalogSchema>;
export type RunErrorResponse = z.infer<typeof runErrorResponseSchema>;
