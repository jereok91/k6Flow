import { describe, expect, it } from "vitest";
import * as shared from "./index";
import {
  deriveRunStartOutcome, idempotencyKeySchema, runErrorCatalogSchema,
  runErrorResponseSchema, runReferenceSchema, runStartConfigSchema, runStateSchema,
  runStatusSchema, runSummarySchema, runTerminalStatusSchema,
  runTotalsSchema, runLatencySchema,
} from "./runs-rest";
// The workspace ships no @types/node; a widened specifier skips static type resolution.
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const max = Number.MAX_SAFE_INTEGER;
const invalidPositive = [undefined, 0, -1, 0.5, max + 1, NaN, Infinity, -Infinity, "1000", null];
const start: shared.RunStartConfig = { version: 1, script: "export default function () {}",
  vus: 2, durationMs: 1000, cpuMillis: 500, memoryMiB: 256 };
const totals = { requests: 10, errors: 1, failedChecks: 2 };
const latency = { avgMs: 12.5, p90Ms: 30, p95Ms: 41.5, p99Ms: 90 };
const finished = { version: 1, runId: "run-1", status: "finished", totals, latency, thresholdsPassed: true };
const openapi = () => readFileSync("docs/api/openapi.yaml", "utf8");
const section = (from: string, to?: string): string => {
  const doc = openapi();
  const fromAt = doc.indexOf(from);
  const toAt = to === undefined ? doc.length : doc.indexOf(to);
  expect(toAt).toBeGreaterThan(fromAt);
  return doc.slice(fromAt, toAt);
};
describe("standalone runs REST declarations", () => {
  it("accepts an approved compiled-script payload with optional opaque attachments", () => {
    expect(runStartConfigSchema.parse(start)).toEqual(start);
    expect(runStartConfigSchema.parse({ ...start, attachments: [{ id: "csv-pool" }] })).toEqual({ ...start, attachments: [{ id: "csv-pool" }] });
  });
  it("accepts an optional K6FLOW_VAR_* env record within the orchestrator limits", () => {
    const env = { K6FLOW_VAR_TOKEN: "s3cret", ["K6FLOW_VAR_" + "A".repeat(80)]: "v".repeat(8192), K6FLOW_VAR_EMPTY: "" };
    expect(runStartConfigSchema.parse({ ...start, env })).toEqual({ ...start, env });
    expect(runStartConfigSchema.parse({ ...start, env: {} })).toEqual({ ...start, env: {} });
    const hundred = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`K6FLOW_VAR_V${i}`, "x"]));
    expect(runStartConfigSchema.safeParse({ ...start, env: hundred }).success).toBe(true);
  });
  it.each([
    ["reserved script key", { K6FLOW_SCRIPT: "x" }],
    ["missing prefix", { TOKEN: "x" }],
    ["lowercase suffix", { K6FLOW_VAR_token: "x" }],
    ["empty suffix", { K6FLOW_VAR_: "x" }],
    ["invalid char", { "K6FLOW_VAR_A-B": "x" }],
    ["suffix over 80", { ["K6FLOW_VAR_" + "A".repeat(81)]: "x" }],
    ["value over 8 KiB", { K6FLOW_VAR_BIG: "a".repeat(8193) }],
    ["non-string value", { K6FLOW_VAR_N: 1 }],
    ["over 100 entries", Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K6FLOW_VAR_V${i}`, "x"]))],
    ["over 64 KiB total", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K6FLOW_VAR_B${i}`, "a".repeat(8192)]))],
  ])("rejects env with %s", (_name, env) => {
    expect(runStartConfigSchema.safeParse({ ...start, env }).success).toBe(false);
  });
  it.each(["version", "script", "vus", "durationMs", "cpuMillis", "memoryMiB"])(
    "requires %s on the run start payload", (field) => {
      const body: Record<string, unknown> = { ...start };
      delete body[field];
      expect(runStartConfigSchema.safeParse(body).success).toBe(false);
    });
  it.each([1, max])("accepts approved safe-integer resource boundary %s", (value) => {
    expect(runStartConfigSchema.parse({ ...start, vus: value, durationMs: value,
      cpuMillis: value, memoryMiB: value }).cpuMillis).toBe(value);
  });
  it.each(invalidPositive)("rejects nonpositive, unsafe or nonnumeric resource %s", (value) => {
    for (const field of ["vus", "durationMs", "cpuMillis", "memoryMiB"]) {
      expect(runStartConfigSchema.safeParse({ ...start, [field]: value }).success).toBe(false);
    }
  });
  it.each([{ script: [] }, { script: { nodes: [] } }, { script: "  " }, { graph: { nodes: [] } },
    { extra: true }, { attachments: [{ id: " " }] }])(
    "rejects nonopaque scripts, graph/extra fields and blank attachment ids %j", (patch) => {
      expect(runStartConfigSchema.safeParse({ ...start, ...patch }).success).toBe(false);
    });
  it("requires the literal version 1 on every declared API body", () => {
    for (const version of [undefined, 0, 2, "1"]) {
      expect(runStartConfigSchema.safeParse({ ...start, version }).success).toBe(false);
      expect(runReferenceSchema.safeParse({ version, runId: "run-1" }).success).toBe(false);
      expect(runStateSchema.safeParse({ version, runId: "run-1", status: "running" }).success).toBe(false);
      expect(runSummarySchema.safeParse({ ...finished, version }).success).toBe(false);
      expect(runErrorResponseSchema.safeParse({ version, code: "unauthorized", message: "declared" }).success).toBe(false);
    }
    expect(runReferenceSchema.safeParse({ version: 1, runId: "run-1" }).success).toBe(true);
  });
  it("declares exactly the five closed lifecycle statuses", () => {
    expect(runStatusSchema.options).toEqual(["pending", "running", "finished", "failed", "stopped"]);
    for (const status of runStatusSchema.options) {
      expect(runStateSchema.parse({ version: 1, runId: "run-1", status }).status).toBe(status);
    }
  });
  it.each(["FINISHED", "cancelled", "stopping", "queued", ""])(
    "rejects lifecycle status %j outside the closed set", (status) => {
      expect(runStatusSchema.safeParse(status).success).toBe(false);
    });
  it("restricts summaries to terminal statuses with per-status thresholdsPassed presence", () => {
    expect(runTerminalStatusSchema.options).toEqual(["finished", "failed", "stopped"]);
    expect(runSummarySchema.parse(finished)).toEqual(finished);
    for (const status of ["pending", "running"]) {
      expect(runSummarySchema.safeParse({ version: 1, runId: "run-1", status, totals, latency }).success).toBe(false);
    }
    for (const status of ["failed", "stopped"]) {
      const summary = { version: 1, runId: "run-1", status, totals, latency };
      expect(runSummarySchema.parse(summary).status).toBe(status);
      expect(runSummarySchema.safeParse({ ...summary, thresholdsPassed: true }).success).toBe(false);
    }
    expect(runSummarySchema.safeParse({ ...finished, thresholdsPassed: undefined }).success).toBe(false);
    expect(runSummarySchema.safeParse({ ...finished, thresholdsPassed: "true" }).success).toBe(false);
  });
  it.each([-1, 0.5, max + 1, NaN, Infinity, "1"])("rejects invalid cumulative counter %j", (value) => {
    for (const field of ["requests", "errors", "failedChecks"]) {
      expect(runSummarySchema.safeParse({ ...finished, totals: { ...totals, [field]: value } }).success).toBe(false);
    }
  });
  it.each([-1, NaN, Infinity, -Infinity, "1"])("rejects invalid latency %j in the summary", (value) => {
    expect(runSummarySchema.safeParse({ ...finished, latency: { ...latency, avgMs: value } }).success).toBe(false);
  });
  it("accepts zeroed cumulative totals and rejects unknown aggregate fields", () => {
    expect(runSummarySchema.safeParse({ ...finished, totals: { requests: 0, errors: 0, failedChecks: 0 },
      latency: { avgMs: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0 } }).success).toBe(true);
    expect(runSummarySchema.safeParse({ ...finished, totals: { requests: 1 } }).success).toBe(false);
  });
  it("declares the exact code/status error catalog with structured bodies", () => {
    const catalog = { unauthorized: 401, "run-not-found": 404, "summary-not-terminal": 409 };
    expect(runErrorCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(runErrorCatalogSchema.safeParse({ ...catalog, timeout: 408 }).success).toBe(false);
    expect(runErrorCatalogSchema.safeParse({ unauthorized: 401 }).success).toBe(false);
    expect(runErrorCatalogSchema.safeParse({ ...catalog, "run-not-found": 410 }).success).toBe(false);
    for (const code of shared.runErrorCodeSchema.options) {
      expect(runErrorResponseSchema.parse({ version: 1, code, message: "declared" }).code).toBe(code);
    }
    expect(runErrorResponseSchema.safeParse({ version: 1, code: "timeout", message: "m" }).success).toBe(false);
    expect(runErrorResponseSchema.safeParse({ version: 1, code: "unauthorized", message: "" }).success).toBe(false);
    expect(runErrorResponseSchema.safeParse({ version: 1, code: "unauthorized", extra: true }).success).toBe(false);
  });
  it("derives creation when the Idempotency-Key is absent or unmatched", () => {
    expect(deriveRunStartOutcome([{ idempotencyKey: "k", runId: "run-1", body: start }], { body: start }))
      .toEqual({ kind: "created" });
    expect(deriveRunStartOutcome([{ idempotencyKey: "k", runId: "run-1", body: start }],
      { idempotencyKey: "k", body: { ...start, vus: 3 } })).toEqual({ kind: "created" });
    expect(deriveRunStartOutcome([{ idempotencyKey: "k", runId: "run-1", body: start }],
      { idempotencyKey: "other", body: start })).toEqual({ kind: "created" });
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
  });
  it("deduplicates an identical key and payload onto the existing run", () => {
    expect(deriveRunStartOutcome([{ idempotencyKey: "k", runId: "run-1", body: start }],
      { idempotencyKey: "k", body: { ...start } })).toEqual({ kind: "deduplicated", runId: "run-1" });
  });
  it("exports inferred types and component validators through the public entry point", () => {
    const config: shared.RunStartConfig = shared.runStartConfigSchema.parse(start);
    const summary: shared.RunSummary = shared.runSummarySchema.parse(finished);
    expect(shared.runStartConfigSchema).toBe(runStartConfigSchema);
    expect(typeof shared.deriveRunStartOutcome).toBe("function");
    // @ts-expect-error Terminal-only summaries cannot declare a running state.
    const premature: shared.RunSummary = { version: 1, runId: "run-1", status: "running", totals, latency };
    expect(shared.runSummarySchema.safeParse(premature).success).toBe(false);
  });
  it("matches the OpenAPI document against the declared contract", () => {
    const doc = openapi();
    const create = section("/api/runs:", "/api/runs/{runId}:");
    for (const fragment of ['"202":', '"200":', '"401":', "Idempotency-Key"]) expect(create).toContain(fragment);
    const state = section("/api/runs/{runId}:", "/api/runs/{runId}/stop:");
    for (const fragment of ['"200":', '"404":']) expect(state).toContain(fragment);
    const stop = section("/api/runs/{runId}/stop:", "/api/runs/{runId}/summary:");
    for (const fragment of ['"202":', '"404":']) expect(stop).toContain(fragment);
    const summary = section("/api/runs/{runId}/summary:", "/healthz:");
    for (const fragment of ['"409":', '"404":']) expect(summary).toContain(fragment);
    expect(doc).toContain(`enum: [${runStatusSchema.options.join(", ")}]`);
    expect(doc).toContain(`enum: [${shared.runErrorCodeSchema.options.join(", ")}]`);
    for (const key of [...Object.keys(runStartConfigSchema.shape), ...Object.keys(runTotalsSchema.shape),
      ...Object.keys(runLatencySchema.shape), "thresholdsPassed"]) expect(doc).toContain(`${key}:`);
    expect(doc).toContain("const: 1");
    expect(doc).toContain(String(max));
    expect(doc).toMatch(/bearerAuth: \{ type: http, scheme: bearer \}/);
    const health = section("/healthz:", "components:");
    expect(health).toContain("security: []");
    expect(health).toContain("const: ok");
    expect(health).not.toContain("bearerAuth");
  });
});
