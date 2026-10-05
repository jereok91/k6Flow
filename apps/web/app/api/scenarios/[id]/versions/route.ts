/**
 * Scenario versions API
 */

import { eq, desc } from "drizzle-orm";
import { getDb } from "../../../../../lib/db/client";
import { scenarios, scenarioVersions } from "../../../../../lib/db/schema";
import { requireUser } from "../../../../../lib/auth/require-user";
import { jsonError } from "../../../../../lib/auth/http";
import { canAccessScenario } from "../../logic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/scenarios/[id]/versions — list versions
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

    // Get versions
    const versions = await db
      .select({
        id: scenarioVersions.id,
        version: scenarioVersions.version,
        changeDescription: scenarioVersions.changeDescription,
        createdAt: scenarioVersions.createdAt,
        createdBy: scenarioVersions.createdBy,
      })
      .from(scenarioVersions)
      .where(eq(scenarioVersions.scenarioId, id))
      .orderBy(desc(scenarioVersions.version));

    const list = versions.map((v) => ({
      ...v,
      createdAt: v.createdAt.toISOString(),
    }));

    return Response.json({ versions: list }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list versions:", e);
    return jsonError(500, "Internal server error");
  }
}
