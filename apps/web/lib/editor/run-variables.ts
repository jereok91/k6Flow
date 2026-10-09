/**
 * k6flow-variables V-T3: client-side variable loading for a run.
 *
 * The browser only ever sees masked variable sets: secrets arrive without a
 * value, so the translator emits `__ENV["K6FLOW_VAR_<NAME>"]` for them and the
 * web server injects the real values (see app/api/orchestrator/runs/run-env.ts).
 */

import {
  mergeVariables,
  type K6TranslationError,
  type ResolvedVariables,
  type VariableInput,
} from "@k6flow/shared";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Maps a `GET .../variables` body to translator inputs; secrets never carry a value. */
export function toVariableInputs(payload: unknown): VariableInput[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const list = (payload as { variables?: unknown }).variables;
  if (!Array.isArray(list)) return null;
  const inputs: VariableInput[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) return null;
    const { name, value, secret } = item as { name?: unknown; value?: unknown; secret?: unknown };
    if (typeof name !== "string" || typeof secret !== "boolean") return null;
    if (secret) {
      inputs.push({ name, secret: true });
    } else {
      if (typeof value !== "string") return null;
      inputs.push({ name, value, secret: false });
    }
  }
  return inputs;
}

/** Environment + scenario variables; scenario variables win by name. */
export function buildRunVariables(
  environmentVars: readonly VariableInput[],
  scenarioVars: readonly VariableInput[],
): ResolvedVariables {
  return mergeVariables(environmentVars, scenarioVars);
}

/** Human-readable message for translation errors that block a run. */
export function formatTranslationErrors(errors: readonly K6TranslationError[]): string {
  return `Cannot run: ${errors.map((error) => error.message).join("; ")}`;
}

export interface RunVariableSources {
  scenarioId?: string;
  environmentId?: string;
}

export type LoadRunVariablesResult =
  | { ok: true; variables: ResolvedVariables }
  | { ok: false; error: string };

async function fetchSet(url: string, label: string, fetchImpl: FetchLike): Promise<VariableInput[] | string> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return `Could not load ${label} (HTTP ${res.status})`;
    const inputs = toVariableInputs(await res.json());
    return inputs ?? `Could not load ${label}: unexpected response`;
  } catch (err) {
    return `Could not load ${label}: ${err instanceof Error ? err.message : "network error"}`;
  }
}

/** Loads the masked variable sets for a run and merges them (scenario wins). */
export async function loadRunVariables(
  sources: RunVariableSources,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<LoadRunVariablesResult> {
  const { scenarioId, environmentId } = sources;
  const [environmentVars, scenarioVars] = await Promise.all([
    environmentId
      ? fetchSet(`/api/environments/${encodeURIComponent(environmentId)}/variables`, "environment variables", fetchImpl)
      : Promise.resolve<VariableInput[]>([]),
    scenarioId
      ? fetchSet(`/api/scenarios/${encodeURIComponent(scenarioId)}/variables`, "scenario variables", fetchImpl)
      : Promise.resolve<VariableInput[]>([]),
  ]);
  if (typeof environmentVars === "string") return { ok: false, error: environmentVars };
  if (typeof scenarioVars === "string") return { ok: false, error: scenarioVars };
  return { ok: true, variables: buildRunVariables(environmentVars, scenarioVars) };
}

/**
 * Reads the web proxy's own error shape (`{ error, errors? }`, e.g. 422 for an
 * unresolvable secret). Returns null for orchestrator bodies and non-JSON.
 */
export function parseProxyRunError(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { error, errors } = parsed as { error?: unknown; errors?: unknown };
  if (typeof error !== "string") return null;
  const details = Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
  return details.length > 0 ? `${error}: ${details.join("; ")}` : error;
}
