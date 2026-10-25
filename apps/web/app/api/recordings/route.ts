/**
 * Recordings API - list recordings and save as scenarios
 */

import { randomUUID } from "node:crypto";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { scenarios, recordings, scenarioVersions } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { graphDraftCompositionSchema } from "@k6flow/shared";
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

    // Create scenario graph from recording. The result is validated against the
    // contract the editor loads: a recording must never store a graph the canvas
    // cannot render.
    const parsedGraph = graphDraftCompositionSchema.safeParse(
      createScenarioGraph(body.entries as ReviewedEntry[]),
    );
    if (!parsedGraph.success) {
      console.error("Recording produced an invalid graph:", parsedGraph.error.issues);
      return jsonError(422, "La grabación no produce un escenario válido");
    }
    const graph = parsedGraph.data;

    const db = getDb();

    // Provenance must be a recording this caller actually owns: an id from
    // another account is dropped instead of being written into the version row.
    const sourceRecordingId = await ownedRecordingId(db, user, body.recordingId);

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
          sourceRecordingId,
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

        await linkRecording(tx, user.id, sourceRecordingId, body.appendToScenarioId);
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
        sourceRecordingId,
        createdBy: user.id,
      });

      await linkRecording(tx, user.id, sourceRecordingId, scenarioId);
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

/** What the link helper needs from a DB handle or an open transaction. */
type Updater = Pick<ReturnType<typeof getDb>, "update">;

/**
 * The recording id to use as provenance, or null when the caller does not own it.
 * Unknown and foreign ids are indistinguishable on purpose, and an admin gets no
 * bypass: the link is owner-scoped, so provenance must be owned too.
 */
async function ownedRecordingId(
  db: ReturnType<typeof getDb>,
  user: { id: string },
  candidate: unknown,
): Promise<string | null> {
  if (typeof candidate !== "string" || candidate === "") return null;
  const [row] = await db
    .select({ ownerId: recordings.ownerId })
    .from(recordings)
    .where(eq(recordings.id, candidate))
    .limit(1);
  if (!row) return null;
  return row.ownerId === user.id ? candidate : null;
}

/**
 * Link a recording to the scenario it produced.
 *
 * Scoped to its owner so a recording id from another account can never be
 * claimed by saving a scenario with that id. The recording's state belongs to
 * the stop route: saving must never mark a live recording completed.
 */
async function linkRecording(
  db: Updater,
  ownerId: string,
  recordingId: unknown,
  scenarioId: string,
): Promise<void> {
  if (typeof recordingId !== "string" || recordingId === "") return;
  await db
    .update(recordings)
    .set({ scenarioId })
    .where(and(eq(recordings.id, recordingId), eq(recordings.ownerId, ownerId)));
}
