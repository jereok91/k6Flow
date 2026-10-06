/**
 * API endpoint for updating run status.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../lib/auth/require-user";
import { isRunOwner, updateRunStatus } from "../../../../lib/editor/run-ownership";

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

    // Validate status
    const validStatuses = ["running", "completed", "failed", "stopped"];
    if (!body.status || !validStatuses.includes(body.status)) {
      return Response.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    await updateRunStatus(runId, {
      status: body.status,
      iterations: body.iterations,
      avgDurationMs: body.avgDurationMs,
      errorRate: body.errorRate,
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
