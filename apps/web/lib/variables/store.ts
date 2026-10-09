// k6flow-variables V-T2: DB access for environments and variables.
//
// Every function takes the acting user and enforces ownership itself:
// - environments are strictly personal: only the owner (admins included) may use them;
// - scenario variables follow the scenario access rule (owner or admin), reusing
//   `canAccessScenario` from the scenarios routes.
// Browser-facing reads return secrets masked (`{ name, secret: true, hasValue }`).
// `resolveVariablesForRun` returns plaintext secrets and is SERVER-ONLY: it must
// never be called from, or its result returned by, a route handler.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { VariableDefinition } from "@k6flow/shared";
import { canAccessScenario } from "../../app/api/scenarios/logic";
import type { SafeUser } from "../auth/safe-user";
import { getDb } from "../db/client";
import { environmentVariables, environments, scenarioVariables, scenarios } from "../db/schema";
import { prepareVariableReplacement } from "./validation";
import type { VariableError, VariableReplaceItem } from "./validation";

export type Actor = Pick<SafeUser, "id" | "role">;

export type MaskedVariable =
  | { name: string; value: string; secret: false }
  | { name: string; secret: true; hasValue: boolean };

export type ExportVariable =
  | { name: string; value: string; secret: false }
  | { name: string; secret: true };

export interface EnvironmentSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type AccessDecision = "ok" | "not-found" | "forbidden";

export type StoreFailure =
  | { ok: false; reason: "not-found" | "forbidden" | "conflict" }
  | { ok: false; reason: "invalid"; errors: VariableError[] };

export type StoreResult<T> = { ok: true; value: T } | StoreFailure;

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/** Masks secrets for the browser: secret entries carry no `value` field at all. */
export function maskVariables(rows: readonly VariableDefinition[]): MaskedVariable[] {
  return rows.map((row) =>
    row.secret
      ? { name: row.name, secret: true, hasValue: row.value.length > 0 }
      : { name: row.name, value: row.value, secret: false },
  );
}

/** Export shape: secrets become `{ name, secret: true }` only. */
export function toExportVariables(rows: readonly VariableDefinition[]): ExportVariable[] {
  return rows.map((row) =>
    row.secret
      ? { name: row.name, secret: true }
      : { name: row.name, value: row.value, secret: false },
  );
}

/** Environments are personal: only the owner may access them, admins included. */
export function classifyEnvironmentAccess(
  row: { ownerId: string } | undefined,
  actor: Actor,
): AccessDecision {
  if (!row) return "not-found";
  return row.ownerId === actor.id ? "ok" : "forbidden";
}

/** Same rule as the scenarios routes (owner or admin). */
export function classifyScenarioAccess(
  row: { ownerId: string } | undefined,
  actor: Actor,
): AccessDecision {
  if (!row) return "not-found";
  return canAccessScenario(row.ownerId, actor as SafeUser) ? "ok" : "forbidden";
}

/** Merges full values for a run: scenario variables override environment ones by name. */
export function mergeVariablesForRun(
  environmentVars: readonly VariableDefinition[],
  scenarioVars: readonly VariableDefinition[],
): VariableDefinition[] {
  const merged = new Map<string, VariableDefinition>();
  for (const variable of [...environmentVars, ...scenarioVars]) {
    merged.set(variable.name, { name: variable.name, value: variable.value, secret: variable.secret });
  }
  return [...merged.values()];
}

/** True for a Postgres unique violation (23505), possibly wrapped as `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 3; depth++) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Maps a store failure to the route error shape (`{ error }`, plus `errors` for 422). */
export function storeFailureResponse(failure: StoreFailure, subject: string): Response {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  switch (failure.reason) {
    case "not-found":
      return new Response(JSON.stringify({ error: `${subject} not found` }), { status: 404, headers });
    case "forbidden":
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    case "conflict":
      return new Response(JSON.stringify({ error: `${subject} with this name already exists` }), { status: 409, headers });
    case "invalid":
      return new Response(JSON.stringify({ error: "Invalid variables", errors: failure.errors }), { status: 422, headers });
  }
}

function deny(decision: Exclude<AccessDecision, "ok">): StoreFailure {
  return { ok: false, reason: decision };
}

function toSummary(row: typeof environments.$inferSelect): EnvironmentSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const definitionColumns = (table: typeof environmentVariables | typeof scenarioVariables) => ({
  name: table.name,
  value: table.value,
  secret: table.secret,
});

// -----------------------------------------------------------------------------
// Environments
// -----------------------------------------------------------------------------

export async function listEnvironments(actor: Actor): Promise<EnvironmentSummary[]> {
  const rows = await getDb()
    .select()
    .from(environments)
    .where(eq(environments.ownerId, actor.id))
    .orderBy(asc(environments.name));
  return rows.map(toSummary);
}

export async function createEnvironment(
  actor: Actor,
  name: string,
): Promise<StoreResult<EnvironmentSummary>> {
  try {
    const [row] = await getDb()
      .insert(environments)
      .values({ id: randomUUID(), ownerId: actor.id, name })
      .returning();
    return { ok: true, value: toSummary(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "conflict" };
    throw error;
  }
}

export async function renameEnvironment(
  actor: Actor,
  environmentId: string,
  name: string,
): Promise<StoreResult<EnvironmentSummary>> {
  const db = getDb();
  const decision = await environmentAccess(db, actor, environmentId);
  if (decision !== "ok") return deny(decision);
  try {
    const [row] = await db
      .update(environments)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(environments.id, environmentId), eq(environments.ownerId, actor.id)))
      .returning();
    if (!row) return deny("not-found");
    return { ok: true, value: toSummary(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "conflict" };
    throw error;
  }
}

export async function deleteEnvironment(
  actor: Actor,
  environmentId: string,
): Promise<StoreResult<{ id: string }>> {
  const db = getDb();
  const decision = await environmentAccess(db, actor, environmentId);
  if (decision !== "ok") return deny(decision);
  // environment_variables rows go with it (ON DELETE CASCADE).
  await db
    .delete(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.ownerId, actor.id)));
  return { ok: true, value: { id: environmentId } };
}

// -----------------------------------------------------------------------------
// Environment variables
// -----------------------------------------------------------------------------

export async function getEnvironmentVariables(
  actor: Actor,
  environmentId: string,
): Promise<StoreResult<MaskedVariable[]>> {
  const db = getDb();
  const decision = await environmentAccess(db, actor, environmentId);
  if (decision !== "ok") return deny(decision);
  return { ok: true, value: maskVariables(await readEnvironmentVariables(db, environmentId)) };
}

export async function replaceEnvironmentVariables(
  actor: Actor,
  environmentId: string,
  items: readonly VariableReplaceItem[],
): Promise<StoreResult<MaskedVariable[]>> {
  return getDb().transaction(async (tx) => {
    // Lock the parent row so concurrent replaces of the same set serialize.
    const [environment] = await tx
      .select({ ownerId: environments.ownerId })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .for("update");
    const decision = classifyEnvironmentAccess(environment, actor);
    if (decision !== "ok") return deny(decision);

    const prepared = prepareVariableReplacement(items, await readEnvironmentVariables(tx, environmentId));
    if (!prepared.ok) return { ok: false, reason: "invalid", errors: prepared.errors };

    const now = new Date();
    await tx.delete(environmentVariables).where(eq(environmentVariables.environmentId, environmentId));
    if (prepared.variables.length > 0) {
      await tx.insert(environmentVariables).values(
        prepared.variables.map((variable) => ({
          id: randomUUID(),
          environmentId,
          ...variable,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await tx.update(environments).set({ updatedAt: now }).where(eq(environments.id, environmentId));
    return { ok: true, value: maskVariables(await readEnvironmentVariables(tx, environmentId)) };
  });
}

// -----------------------------------------------------------------------------
// Scenario variables
// -----------------------------------------------------------------------------

export async function getScenarioVariables(
  actor: Actor,
  scenarioId: string,
): Promise<StoreResult<MaskedVariable[]>> {
  const db = getDb();
  const decision = await scenarioAccess(db, actor, scenarioId);
  if (decision !== "ok") return deny(decision);
  return { ok: true, value: maskVariables(await readScenarioVariables(db, scenarioId)) };
}

/** Export-safe scenario variables: secrets carry no value (no `hasValue` either). */
export async function getScenarioVariablesForExport(
  actor: Actor,
  scenarioId: string,
): Promise<StoreResult<ExportVariable[]>> {
  const db = getDb();
  const decision = await scenarioAccess(db, actor, scenarioId);
  if (decision !== "ok") return deny(decision);
  return { ok: true, value: toExportVariables(await readScenarioVariables(db, scenarioId)) };
}

export async function replaceScenarioVariables(
  actor: Actor,
  scenarioId: string,
  items: readonly VariableReplaceItem[],
): Promise<StoreResult<MaskedVariable[]>> {
  return getDb().transaction(async (tx) => {
    const [scenario] = await tx
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, scenarioId))
      .for("update");
    const decision = classifyScenarioAccess(scenario, actor);
    if (decision !== "ok") return deny(decision);

    const prepared = prepareVariableReplacement(items, await readScenarioVariables(tx, scenarioId));
    if (!prepared.ok) return { ok: false, reason: "invalid", errors: prepared.errors };

    const now = new Date();
    await tx.delete(scenarioVariables).where(eq(scenarioVariables.scenarioId, scenarioId));
    if (prepared.variables.length > 0) {
      await tx.insert(scenarioVariables).values(
        prepared.variables.map((variable) => ({
          id: randomUUID(),
          scenarioId,
          ...variable,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    return { ok: true, value: maskVariables(await readScenarioVariables(tx, scenarioId)) };
  });
}

// -----------------------------------------------------------------------------
// Run resolution — SERVER-ONLY (plaintext secrets)
// -----------------------------------------------------------------------------

/**
 * Full variable values for a run, scenario overriding environment by name.
 * SERVER-ONLY: returns plaintext secrets. Never expose through a route; the run
 * proxy (V-T3) uses it to inject secrets as k6 env.
 * The scenario, when given, must be accessible to the actor (owner or admin)
 * and the environment, when given, must belong to the actor. A null scenario
 * (ad-hoc run of an unsaved graph) resolves environment variables only.
 */
export async function resolveVariablesForRun(
  actor: Actor,
  scenarioId: string | null,
  environmentId: string | null,
): Promise<StoreResult<VariableDefinition[]>> {
  const db = getDb();
  if (scenarioId !== null) {
    const scenarioDecision = await scenarioAccess(db, actor, scenarioId);
    if (scenarioDecision !== "ok") return deny(scenarioDecision);
  }
  let environmentVars: VariableDefinition[] = [];
  if (environmentId !== null) {
    const environmentDecision = await environmentAccess(db, actor, environmentId);
    if (environmentDecision !== "ok") return deny(environmentDecision);
    environmentVars = await readEnvironmentVariables(db, environmentId);
  }
  const scenarioVars = scenarioId === null ? [] : await readScenarioVariables(db, scenarioId);
  return { ok: true, value: mergeVariablesForRun(environmentVars, scenarioVars) };
}

// -----------------------------------------------------------------------------
// Internal queries
// -----------------------------------------------------------------------------

type Executor = Pick<ReturnType<typeof getDb>, "select">;

async function environmentAccess(db: Executor, actor: Actor, environmentId: string): Promise<AccessDecision> {
  const [row] = await db
    .select({ ownerId: environments.ownerId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return classifyEnvironmentAccess(row, actor);
}

async function scenarioAccess(db: Executor, actor: Actor, scenarioId: string): Promise<AccessDecision> {
  const [row] = await db
    .select({ ownerId: scenarios.ownerId })
    .from(scenarios)
    .where(eq(scenarios.id, scenarioId))
    .limit(1);
  return classifyScenarioAccess(row, actor);
}

function readEnvironmentVariables(db: Executor, environmentId: string): Promise<VariableDefinition[]> {
  return db
    .select(definitionColumns(environmentVariables))
    .from(environmentVariables)
    .where(eq(environmentVariables.environmentId, environmentId))
    .orderBy(asc(environmentVariables.name));
}

function readScenarioVariables(db: Executor, scenarioId: string): Promise<VariableDefinition[]> {
  return db
    .select(definitionColumns(scenarioVariables))
    .from(scenarioVariables)
    .where(eq(scenarioVariables.scenarioId, scenarioId))
    .orderBy(asc(scenarioVariables.name));
}
