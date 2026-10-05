/**
 * Single browser state API
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { browserStates } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/browser-states/[id] - get full state with storageState
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
    const [state] = await db
      .select()
      .from(browserStates)
      .where(eq(browserStates.id, id))
      .limit(1);

    if (!state) {
      return jsonError(404, "Browser state not found");
    }

    if (state.ownerId !== user.id && user.role !== "admin") {
      return jsonError(403, "Forbidden");
    }

    // Check expiration
    const isExpired = state.expiresAt ? state.expiresAt < new Date() : false;

    return Response.json({
      id: state.id,
      name: state.name,
      storageState: state.storageState,
      sourceUrl: state.sourceUrl,
      sourceScenarioId: state.sourceScenarioId,
      viewportWidth: state.viewportWidth,
      viewportHeight: state.viewportHeight,
      expiresAt: state.expiresAt?.toISOString() || null,
      isExpired,
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to get browser state:", e);
    return jsonError(500, "Internal server error");
  }
}

// DELETE /api/browser-states/[id] - delete state
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
    const [state] = await db
      .select({ ownerId: browserStates.ownerId })
      .from(browserStates)
      .where(eq(browserStates.id, id))
      .limit(1);

    if (!state) {
      return jsonError(404, "Browser state not found");
    }

    if (state.ownerId !== user.id && user.role !== "admin") {
      return jsonError(403, "Forbidden");
    }

    await db.delete(browserStates).where(eq(browserStates.id, id));

    return Response.json({ deleted: true });
  } catch (e) {
    console.error("Failed to delete browser state:", e);
    return jsonError(500, "Internal server error");
  }
}

// PATCH /api/browser-states/[id] - update name or extend expiration
export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  let body: { name?: string; extendHours?: number };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  try {
    const db = getDb();
    const [state] = await db
      .select()
      .from(browserStates)
      .where(eq(browserStates.id, id))
      .limit(1);

    if (!state) {
      return jsonError(404, "Browser state not found");
    }

    if (state.ownerId !== user.id && user.role !== "admin") {
      return jsonError(403, "Forbidden");
    }

    const updates: { name?: string; expiresAt?: Date; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (body.name) {
      updates.name = body.name.trim();
    }

    if (body.extendHours && body.extendHours > 0) {
      const currentExpires = state.expiresAt || new Date();
      updates.expiresAt = new Date(currentExpires.getTime() + body.extendHours * 60 * 60 * 1000);
    }

    await db
      .update(browserStates)
      .set(updates)
      .where(eq(browserStates.id, id));

    return Response.json({ 
      updated: true,
      expiresAt: updates.expiresAt?.toISOString() || state.expiresAt?.toISOString(),
    });
  } catch (e) {
    console.error("Failed to update browser state:", e);
    return jsonError(500, "Internal server error");
  }
}
