/**
 * Folders API - list and create folders
 */

import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { folders } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";

// GET /api/folders - list user's folders (hierarchical)
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
      .from(folders)
      .where(eq(folders.ownerId, user.id))
      .orderBy(folders.name);

    // Build hierarchical structure
    const folderMap = new Map<string, {
      id: string;
      name: string;
      parentId: string | null;
      children: string[];
      createdAt: string;
    }>();

    for (const f of rows) {
      folderMap.set(f.id, {
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        children: [],
        createdAt: f.createdAt.toISOString(),
      });
    }

    // Link children to parents
    for (const f of folderMap.values()) {
      if (f.parentId && folderMap.has(f.parentId)) {
        folderMap.get(f.parentId)!.children.push(f.id);
      }
    }

    // Get root folders
    const rootFolders = Array.from(folderMap.values()).filter(f => !f.parentId);

    return Response.json({ 
      folders: Array.from(folderMap.values()),
      rootFolders: rootFolders.map(f => f.id),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list folders:", e);
    return jsonError(500, "Internal server error");
  }
}

// POST /api/folders - create a new folder
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: { name?: string; parentId?: string | null };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return jsonError(400, "Folder name is required");
  }

  const name = body.name.trim();
  const parentId = body.parentId || null;

  try {
    const db = getDb();

    // If parentId is provided, verify it exists and belongs to user
    if (parentId) {
      const [parent] = await db
        .select()
        .from(folders)
        .where(eq(folders.id, parentId))
        .limit(1);

      if (!parent || parent.ownerId !== user.id) {
        return jsonError(404, "Parent folder not found");
      }
    }

    const id = randomUUID();
    await db.insert(folders).values({
      id,
      ownerId: user.id,
      name,
      parentId,
    });

    return Response.json({ id, name, parentId }, { status: 201 });
  } catch (e) {
    console.error("Failed to create folder:", e);
    return jsonError(500, "Internal server error");
  }
}
