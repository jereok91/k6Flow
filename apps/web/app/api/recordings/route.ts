/**
 * POST /api/recordings - Save a recording as a new scenario
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../lib/db/client";
import { scenarios } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { createScenarioGraph, type ReviewedEntry } from "../../../lib/recorder/save-recording";

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
