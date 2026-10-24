/**
 * Recordings API - list recordings and save as scenarios
 */

import { randomUUID } from "node:crypto";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { scenarios, recordings, scenarioVersions } from "../../../lib/db/schema";
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

// POST /api/recordings - save recording as new scenario or append to existing
export async function POST(request: Request): Promise<Response> {  const cookieHeader = request.headers.get("cookie");
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

    const db = getDb();

    // K6R7-02: Append to existing scenario if appendToScenarioId provided
    if (body.appendToScenarioId) {
      // Verify scenario exists and user has access
      const [existing] = await db
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, body.appendToScenarioId))
        .limit(1);

      if (!existing) {
        return jsonError(404, "Scenario not found");
      }

      if (existing.ownerId !== user.id && user.role !== "admin") {
        return jsonError(403, "Forbidden");
      }

      // Save current graph as a version
      const [maxVersion] = await db
        .select({ version: sql<number>`COALESCE(MAX(version), 0)` })
        .from(scenarioVersions)
        .where(eq(scenarioVersions.scenarioId, body.appendToScenarioId));

      const nextVersion = (maxVersion?.version || 0) + 1;

      // One transaction: a version without its graph update (or an unlinked
      // recording) must not survive a half-failed append.
      await db.transaction(async (tx) => {
        await tx.insert(scenarioVersions).values({
          id: randomUUID(),
          scenarioId: body.appendToScenarioId,
          version: nextVersion,
          graph: existing.graph,
          changeDescription: `Before appending recording: ${body.name}`,
          sourceRecordingId: body.recordingId || null,
          createdBy: user.id,
        });

        // Update scenario with new graph
        await tx
          .update(scenarios)
          .set({
            graph,
            updatedAt: new Date(),
          })
          .where(eq(scenarios.id, body.appendToScenarioId));

        await linkRecording(tx, user.id, body.recordingId, body.appendToScenarioId);
      });

      return Response.json({
        id: body.appendToScenarioId,
        name: existing.name,
        version: nextVersion + 1,
        appended: true,
        requestCount: body.entries.length,
      });
    }

    // Create new scenario
    const scenarioId = randomUUID();

    // One transaction: the scenario, its first version and the recording link are
    // one save. A retry after a half-failed write must not duplicate any of them.
    await db.transaction(async (tx) => {
      await tx.insert(scenarios).values({
        id: scenarioId,
        ownerId: user.id,
        name: body.name,
        graph,
      });

      // The graph this save produced is the scenario's first version, so its history
      // starts at what was created and keeps the recording it came from as provenance.
      await tx.insert(scenarioVersions).values({
        id: randomUUID(),
        scenarioId,
        version: 1,
        graph,
        changeDescription: `Created from recording: ${body.name}`,
        sourceRecordingId: typeof body.recordingId === "string" && body.recordingId !== ""
          ? body.recordingId
          : null,
        createdBy: user.id,
      });

      await linkRecording(tx, user.id, body.recordingId, scenarioId);
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

/** A DB handle or an open transaction: helpers accept either. */
type Executor = ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Link a recording to the scenario it produced.
 *
 * Scoped to its owner so a recording id from another account can never be
 * claimed by saving a scenario with that id.
 */
async function linkRecording(
  db: Executor,
  ownerId: string,
  recordingId: unknown,
  scenarioId: string,
): Promise<void> {
  if (typeof recordingId !== "string" || recordingId === "") return;
  await db
    .update(recordings)
    .set({ scenarioId, state: "completed" })
    .where(and(eq(recordings.id, recordingId), eq(recordings.ownerId, ownerId)));
}
