/**
 * Single version API
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../../../../../../lib/db/client";
import { scenarios, scenarioVersions } from "../../../../../../lib/db/schema";
import { requireUser } from "../../../../../../lib/auth/require-user";
import { jsonError } from "../../../../../../lib/auth/http";
import { canAccessScenario } from "../../../logic";

interface RouteContext {
  params: Promise<{ id: string; versionId: string }>;
}

// GET /api/scenarios/[id]/versions/[versionId] — get version with full graph
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id, versionId } = await context.params;

  try {
    const db = getDb();

    // Check scenario exists and user has access
    const [scenario] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!scenario) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(scenario.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    // Get version
    const [version] = await db
      .select()
      .from(scenarioVersions)
      .where(
        and(
          eq(scenarioVersions.scenarioId, id),
          eq(scenarioVersions.id, versionId),
        ),
      )
      .limit(1);

    if (!version) {
      return jsonError(404, "Version not found");
    }

    return Response.json({
      id: version.id,
      version: version.version,
      graph: version.graph,
      changeDescription: version.changeDescription,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to get version:", e);
    return jsonError(500, "Internal server error");
  }
}
