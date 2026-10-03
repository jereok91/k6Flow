// Single scenario routes: get, update, delete.
// Owner or admin only. DB-backed paths proven in K6F4-06 real-stack e2e.

import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { scenarios } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { canAccessScenario, classifyUpdateScenario } from "../logic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/scenarios/[id] — get single scenario with full graph
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!row) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(row.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    return Response.json({
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      graph: row.graph,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(500, "Internal server error");
  }
}

// PUT /api/scenarios/[id] — update scenario (name and/or graph)
export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  const classified = classifyUpdateScenario(body);
  if (!classified.ok) {
    const status = classified.reason === "invalid-graph" ? 422 : 400;
    return jsonError(status, classified.message);
  }

  try {
    const db = getDb();

    // Check existence and access
    const [existing] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!existing) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(existing.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    // Build update object
    const updates: { name?: string; graph?: unknown; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (classified.name !== undefined) updates.name = classified.name;
    if (classified.graph !== undefined) updates.graph = classified.graph;

    await db
      .update(scenarios)
      .set(updates)
      .where(eq(scenarios.id, id));

    return Response.json({ id, updated: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(500, "Internal server error");
  }
}

// DELETE /api/scenarios/[id] — delete scenario
export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const db = getDb();

    // Check existence and access
    const [existing] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!existing) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(existing.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    await db.delete(scenarios).where(eq(scenarios.id, id));

    return Response.json({ id, deleted: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(500, "Internal server error");
  }
}
