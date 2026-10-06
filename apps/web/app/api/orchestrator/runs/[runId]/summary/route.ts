/**
 * Proxy for orchestrator run summary endpoint.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../../../lib/auth/require-user";
import { isRunOwner } from "../../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

export async function GET(
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
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}/summary`, {
      headers: {
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
      },
    });

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Proxy error" },
      { status: 502 }
    );
  }
}
