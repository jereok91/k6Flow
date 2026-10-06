/**
 * API endpoint for run history.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../lib/auth/require-user";
import { getUserRunHistory } from "../../../lib/editor/run-ownership";

export async function GET(request: NextRequest) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

    const history = await getUserRunHistory(user.id, limit);

    // Transform to frontend format
    const runs = history.map((run) => ({
      runId: run.runId,
      scenarioId: run.scenarioId,
      scenarioName: run.scenarioName || "Sin nombre",
      status: run.status,
      vus: run.vus || 1,
      durationMs: run.durationMs,
      iterations: run.iterations || 0,
      avgDurationMs: run.avgDurationMs,
      errorRate: run.errorRate !== null ? run.errorRate / 100 : undefined, // Convert back to percentage
      startedAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    }));

    return Response.json({ runs });
  } catch (error) {
    console.error("Failed to fetch run history:", error);
    return Response.json(
      { error: "Failed to fetch run history" },
      { status: 500 }
    );
  }
}
