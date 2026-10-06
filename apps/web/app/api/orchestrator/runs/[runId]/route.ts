/**
 * Proxy for orchestrator run status endpoint.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../../lib/auth/require-user";
import { isRunOwner, getRunOwner } from "../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await context.params;

  // Verify run ownership - only allow access to runs created by this user
  // Fail-closed: if ownership is unknown (not in DB), deny access
  const owner = await getRunOwner(runId);
  if (!owner) {
    return Response.json({ error: "Forbidden: run ownership unknown" }, { status: 403 });
  }
  if (!(await isRunOwner(runId, user.id))) {
    return Response.json({ error: "Forbidden: not run owner" }, { status: 403 });
  }
  
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}`, {
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
