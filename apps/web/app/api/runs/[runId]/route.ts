/**
 * API endpoint for updating run status.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../lib/auth/require-user";
import { isRunOwner, updateRunStatus } from "../../../../lib/editor/run-ownership";
import { toHistoryStatus } from "../../../../lib/editor/run-status";

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;

  // Verify ownership
  const isOwner = await isRunOwner(runId, user.id);
  if (!isOwner) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = await request.json();

    // Normalize orchestrator statuses (e.g. "finished") to the history vocabulary
    const status = toHistoryStatus(body?.status);
    if (!status) {
      return Response.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    await updateRunStatus(runId, {
      status,
      iterations: finiteOrUndefined(body.iterations),
      avgDurationMs: finiteOrUndefined(body.avgDurationMs),
      errorRate: finiteOrUndefined(body.errorRate),
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to update run status:", error);
    return Response.json(
      { error: "Failed to update run status" },
      { status: 500 }
    );
  }
}
