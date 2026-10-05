/**
 * Tags API - list and create tags
 */

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { tags } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";

// GET /api/tags - list user's tags
export async function GET(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.ownerId, user.id))
      .orderBy(tags.name);

    const list = rows.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      createdAt: t.createdAt.toISOString(),
    }));

    return Response.json({ tags: list }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list tags:", e);
    return jsonError(500, "Internal server error");
  }
}

// POST /api/tags - create a new tag
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: { name?: string; color?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return jsonError(400, "Tag name is required");
  }

  const name = body.name.trim();
  const color = body.color || "#6B7280";

  try {
    const db = getDb();

    // Check for duplicate
    const [existing] = await db
      .select()
      .from(tags)
      .where(and(eq(tags.ownerId, user.id), eq(tags.name, name)))
      .limit(1);

    if (existing) {
      return jsonError(409, "Tag with this name already exists");
    }

    const id = randomUUID();
    await db.insert(tags).values({
      id,
      ownerId: user.id,
      name,
      color,
    });

    return Response.json({ id, name, color }, { status: 201 });
  } catch (e) {
    console.error("Failed to create tag:", e);
    return jsonError(500, "Internal server error");
  }
}
