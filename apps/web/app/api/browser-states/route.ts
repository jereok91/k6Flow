/**
 * Browser States API - save and restore browser state (cookies, localStorage)
 */

import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { browserStates } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";

// GET /api/browser-states - list user's saved states
export async function GET(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const db = getDb();
    const rows = await db
      .select({
        id: browserStates.id,
        name: browserStates.name,
        sourceUrl: browserStates.sourceUrl,
        sourceScenarioId: browserStates.sourceScenarioId,
        viewportWidth: browserStates.viewportWidth,
        viewportHeight: browserStates.viewportHeight,
        expiresAt: browserStates.expiresAt,
        createdAt: browserStates.createdAt,
        updatedAt: browserStates.updatedAt,
      })
      .from(browserStates)
      .where(eq(browserStates.ownerId, user.id))
      .orderBy(desc(browserStates.updatedAt));

    const list = rows.map((s) => ({
      ...s,
      expiresAt: s.expiresAt?.toISOString() || null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      isExpired: s.expiresAt ? s.expiresAt < new Date() : false,
    }));

    return Response.json({ states: list }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list browser states:", e);
    return jsonError(500, "Internal server error");
  }
}

// POST /api/browser-states - save a new browser state
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: {
    name?: string;
    storageState?: unknown;
    sourceUrl?: string;
    sourceScenarioId?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    expiresInHours?: number;
  };

  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.name || typeof body.name !== "string") {
    return jsonError(400, "Name is required");
  }

  if (!body.storageState || typeof body.storageState !== "object") {
    return jsonError(400, "storageState is required");
  }

  try {
    const db = getDb();
    const id = randomUUID();

    // Default expiration: 24 hours
    const expiresInHours = body.expiresInHours ?? 24;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    await db.insert(browserStates).values({
      id,
      ownerId: user.id,
      name: body.name.trim(),
      storageState: body.storageState,
      sourceUrl: body.sourceUrl || null,
      sourceScenarioId: body.sourceScenarioId || null,
      viewportWidth: body.viewportWidth || 1280,
      viewportHeight: body.viewportHeight || 720,
      expiresAt,
    });

    return Response.json({ id, expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (e) {
    console.error("Failed to save browser state:", e);
    return jsonError(500, "Internal server error");
  }
}
