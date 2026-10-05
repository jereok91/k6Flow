/**
 * Recordings API - list recordings and save as scenarios
 */

import { randomUUID } from "node:crypto";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { scenarios, recordings } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { createScenarioGraph, type ReviewedEntry } from "../../../lib/recorder/save-recording";

// GET /api/recordings - list user's recordings
export async function GET(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") || "";
    const state = url.searchParams.get("state"); // filter by state
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
    const offset = (page - 1) * pageSize;

    const db = getDb();

    // Build conditions
    const conditions = [];
    if (user.role !== "admin") {
      conditions.push(eq(recordings.ownerId, user.id));
    }
    if (search) {
      conditions.push(like(recordings.name, `%${search}%`));
    }
    if (state) {
      conditions.push(eq(recordings.state, state));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(recordings)
      .where(whereClause);
    const total = Number(countResult[0]?.count || 0);

    // Get paginated results
    const rows = await db
      .select({
        id: recordings.id,
        name: recordings.name,
        startUrl: recordings.startUrl,
        state: recordings.state,
        durationMs: recordings.durationMs,
        requestCount: recordings.requestCount,
        stepCount: recordings.stepCount,
        scenarioId: recordings.scenarioId,
        createdAt: recordings.createdAt,
        completedAt: recordings.completedAt,
      })
      .from(recordings)
      .where(whereClause)
      .orderBy(desc(recordings.createdAt))
      .limit(pageSize)
      .offset(offset);

    const list = rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() || null,
    }));

    return Response.json(
      { recordings: list, total, page, pageSize },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("Failed to list recordings:", e);
    return jsonError(500, "Internal server error");
  }
}

export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const body = await request.json();

    // Basic validation
    if (!body.name || typeof body.name !== "string") {
      return jsonError(400, "Missing scenario name");
    }
    if (!body.startUrl || typeof body.startUrl !== "string") {
      return jsonError(400, "Missing start URL");
    }
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return jsonError(400, "No entries to save");
    }

    // Create scenario graph from recording
    const graph = createScenarioGraph(body.entries as ReviewedEntry[], {
      name: body.name,
      startUrl: body.startUrl,
      viewport: body.viewport || { width: 1280, height: 720 },
      recordingId: body.recordingId,
    });

    // Save to database
    const db = getDb();
    const scenarioId = randomUUID();
    await db.insert(scenarios).values({
      id: scenarioId,
      ownerId: user.id,
      name: body.name,
      graph,
    });

    return Response.json({
      id: scenarioId,
      name: body.name,
      requestCount: body.entries.length,
    });
  } catch (error) {
    console.error("Failed to save recording:", error);
    return jsonError(500, "Failed to save recording");
  }
}
