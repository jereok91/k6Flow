/**
 * GET /api/recordings/[id] — one saved recording with its raw capture.
 *
 * The review screen reads the capture from here, so a finished recording is
 * reviewable by id without asking the user for a local `.ndjson` file.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { recordings } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const db = getDb();
    const [row] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);

    if (!row) {
      return jsonError(404, "Recording not found");
    }
    if (row.ownerId !== user.id && user.role !== "admin") {
      return jsonError(403, "Forbidden");
    }

    return Response.json(
      {
        recording: {
          id: row.id,
          name: row.name,
          startUrl: row.startUrl,
          state: row.state,
          viewport: { width: row.viewportWidth, height: row.viewportHeight },
          durationMs: row.durationMs ?? 0,
          requestCount: row.requestCount ?? 0,
          stepCount: row.stepCount ?? 0,
          scenarioId: row.scenarioId,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
        },
        capture: row.captureData ?? "",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to read recording:", error);
    return jsonError(500, "Internal server error");
  }
}
