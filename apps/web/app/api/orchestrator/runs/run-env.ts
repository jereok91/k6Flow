/**
 * k6flow-variables V-T3: server-side secret env for a run start.
 *
 * The client's `requiredEnv` is only a request for env NAMES. Values come from
 * the database through `resolveVariablesForRun` (scenario overrides
 * environment) and only for secret variables. A client-sent `env` is always
 * discarded. Nothing here logs, and no error message carries a value.
 */

import {
  findSecretEnvCollisions,
  secretEnvName,
  type VariableDefinition,
} from "@k6flow/shared";
import type { Actor, StoreResult } from "../../../../lib/variables/store";

/** Same key rule the orchestrator enforces on `env`. */
export const RUN_ENV_KEY_PATTERN = /^K6FLOW_VAR_[A-Z0-9_]{1,80}$/;
export const MAX_RUN_ENV_ENTRIES = 100;

/** Fields the proxy consumes; the orchestrator rejects unknown fields. */
const PROXY_ONLY_FIELDS = ["scenarioId", "scenarioName", "environmentId", "requiredEnv", "env"] as const;

export interface RunEnvRequest {
  scenarioId: string | null;
  environmentId: string | null;
  /** Sorted, unique env names. */
  requiredEnv: string[];
}

export type ResolveVariables = (
  actor: Actor,
  scenarioId: string | null,
  environmentId: string | null,
) => Promise<StoreResult<VariableDefinition[]>>;

export type ParseRunEnvResult = { ok: true; value: RunEnvRequest } | { ok: false; error: string };

function optionalId(value: unknown, field: string): { ok: true; id: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, id: null };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${field} must be a nonblank string` };
  }
  return { ok: true, id: value };
}

/** Validates the proxy-only run fields (scenarioId, environmentId, requiredEnv). */
export function parseRunEnvRequest(body: Record<string, unknown>): ParseRunEnvResult {
  const scenario = optionalId(body.scenarioId, "scenarioId");
  if (!scenario.ok) return scenario;
  const environment = optionalId(body.environmentId, "environmentId");
  if (!environment.ok) return environment;

  const raw = body.requiredEnv ?? [];
  if (!Array.isArray(raw)) return { ok: false, error: "requiredEnv must be an array" };
  const names = new Set<string>();
  for (const name of raw) {
    if (typeof name !== "string" || !RUN_ENV_KEY_PATTERN.test(name)) {
      return { ok: false, error: "requiredEnv entries must match ^K6FLOW_VAR_[A-Z0-9_]{1,80}$" };
    }
    names.add(name);
  }
  if (names.size > MAX_RUN_ENV_ENTRIES) {
    return { ok: false, error: `requiredEnv has more than ${MAX_RUN_ENV_ENTRIES} entries` };
  }
  return {
    ok: true,
    value: { scenarioId: scenario.id, environmentId: environment.id, requiredEnv: [...names].sort() },
  };
}

export type BuildRunEnvResult = { ok: true; env: Record<string, string> } | { ok: false; errors: string[] };

/**
 * Env map for the required names, taken only from secret variables of the
 * resolved (merged) set. Rejects colliding secrets and names without a value.
 */
export function buildRunEnv(
  requiredEnv: readonly string[],
  resolved: readonly VariableDefinition[],
): BuildRunEnvResult {
  const errors: string[] = [];
  for (const collision of findSecretEnvCollisions(resolved.map((v) => [v.name, { secret: v.secret }] as [string, { secret: boolean }]))) {
    errors.push(`Secret variables ${collision.names.join(", ")} all map to env ${collision.envName}`);
  }
  const secretsByEnv = new Map<string, string>();
  for (const variable of resolved) {
    if (variable.secret) secretsByEnv.set(secretEnvName(variable.name), variable.value);
  }
  const env: Record<string, string> = {};
  for (const envName of requiredEnv) {
    const value = secretsByEnv.get(envName);
    if (value === undefined || value === "") {
      errors.push(`No secret value available for ${envName}`);
      continue;
    }
    env[envName] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, env };
}

/** Orchestrator body: proxy-only and client `env` fields removed, server env added. */
export function toOrchestratorBody(
  body: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const field of PROXY_ONLY_FIELDS) delete out[field];
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

export type PrepareRunStartResult =
  | { ok: true; orchestratorBody: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 422; error: string; errors?: string[] };

/**
 * Validates the proxy fields, enforces scenario/environment ownership through
 * `resolve` (owner or admin for scenarios, owner only for environments) and
 * builds the orchestrator body with server-resolved secret env.
 */
export async function prepareRunStart(
  body: unknown,
  actor: Actor,
  resolve: ResolveVariables,
): Promise<PrepareRunStartResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Invalid run request" };
  }
  const record = body as Record<string, unknown>;
  const parsed = parseRunEnvRequest(record);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { scenarioId, environmentId, requiredEnv } = parsed.value;

  if (scenarioId === null && environmentId === null) {
    if (requiredEnv.length > 0) {
      return { ok: false, status: 422, error: "Secret variables require a scenario or an environment" };
    }
    return { ok: true, orchestratorBody: toOrchestratorBody(record, {}) };
  }

  const resolved = await resolve(actor, scenarioId, environmentId);
  if (!resolved.ok) {
    switch (resolved.reason) {
      case "forbidden":
        return { ok: false, status: 403, error: "Forbidden" };
      case "not-found":
        return { ok: false, status: 404, error: scenarioId !== null ? "Scenario or environment not found" : "Environment not found" };
      default:
        return { ok: false, status: 422, error: "Variables could not be resolved" };
    }
  }

  const env = buildRunEnv(requiredEnv, resolved.value);
  if (!env.ok) {
    return { ok: false, status: 422, error: "Secret variables could not be resolved", errors: env.errors };
  }
  return { ok: true, orchestratorBody: toOrchestratorBody(record, env.env) };
}
