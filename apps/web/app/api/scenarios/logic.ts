// Scenario CRUD logic — pure decision functions, no DB.
// DB-backed paths proven in K6F4-06 real-stack e2e.

import { graphDraftCompositionSchema } from "@k6flow/shared";
import type { GraphDraftComposition } from "@k6flow/shared";
import type { SafeUser } from "../../../lib/auth/safe-user";

// -----------------------------------------------------------------------------
// Graph validation
// -----------------------------------------------------------------------------

export type GraphValidationResult =
  | { valid: true; graph: GraphDraftComposition }
  | { valid: false; errors: string[] };

export function validateGraph(input: unknown): GraphValidationResult {
  const result = graphDraftCompositionSchema.safeParse(input);
  if (result.success) {
    return { valid: true, graph: result.data };
  }
  // Flatten Zod issues into human-readable strings
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  return { valid: false, errors };
}

// -----------------------------------------------------------------------------
// Access control
// -----------------------------------------------------------------------------

export function canAccessScenario(
  scenarioOwnerId: string,
  user: SafeUser,
): boolean {
  return user.id === scenarioOwnerId || user.role === "admin";
}

// -----------------------------------------------------------------------------
// Body shape validation
// -----------------------------------------------------------------------------

export interface CreateScenarioBody {
  name: string;
  graph: unknown;
}

export type CreateScenarioResult =
  | { ok: true; name: string; graph: GraphDraftComposition }
  | { ok: false; reason: "invalid-shape" | "invalid-graph"; message: string };

export function classifyCreateScenario(body: unknown): CreateScenarioResult {
  if (
    typeof body !== "object" ||
    body === null ||
    !("name" in body) ||
    !("graph" in body)
  ) {
    return { ok: false, reason: "invalid-shape", message: "Missing name or graph" };
  }

  const { name, graph } = body as { name: unknown; graph: unknown };

  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "invalid-shape", message: "Name must be a non-empty string" };
  }

  const graphResult = validateGraph(graph);
  if (!graphResult.valid) {
    return {
      ok: false,
      reason: "invalid-graph",
      message: `Invalid graph: ${graphResult.errors.join("; ")}`,
    };
  }

  return { ok: true, name: name.trim(), graph: graphResult.graph };
}

export interface UpdateScenarioBody {
  name?: string;
  graph?: unknown;
}

export type UpdateScenarioResult =
  | { ok: true; name?: string; graph?: GraphDraftComposition }
  | { ok: false; reason: "invalid-shape" | "invalid-graph" | "empty-update"; message: string };

export function classifyUpdateScenario(body: unknown): UpdateScenarioResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "invalid-shape", message: "Body must be an object" };
  }

  const { name, graph } = body as { name?: unknown; graph?: unknown };

  // At least one field must be present
  const hasName = "name" in (body as object);
  const hasGraph = "graph" in (body as object);
  if (!hasName && !hasGraph) {
    return { ok: false, reason: "empty-update", message: "No fields to update" };
  }

  let validatedName: string | undefined;
  let validatedGraph: GraphDraftComposition | undefined;

  if (hasName) {
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, reason: "invalid-shape", message: "Name must be a non-empty string" };
    }
    validatedName = name.trim();
  }

  if (hasGraph) {
    const graphResult = validateGraph(graph);
    if (!graphResult.valid) {
      return {
        ok: false,
        reason: "invalid-graph",
        message: `Invalid graph: ${graphResult.errors.join("; ")}`,
      };
    }
    validatedGraph = graphResult.graph;
  }

  return { ok: true, name: validatedName, graph: validatedGraph };
}
