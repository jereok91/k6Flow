/**
 * Proxy for orchestrator run stop endpoint.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../../../lib/auth/require-user";
import { checkExpectedSession, expectedSessionFailure, SESSION_MARKER_HEADER } from "../../../../../../lib/auth/expected-session";
import { isRunOwner, getRunOwner } from "../../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// Generic, marker-free failure for the session-bound (diagnostic) path.
const proxyError = () => Response.json({ error: "Proxy error" }, { status: 502, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest, context: RouteContext) {
  // Stop is shared with load runs: only a request carrying the marker header
  // is bound to the expected session; otherwise the cookie-only check applies.
  const marked = request.headers.has(SESSION_MARKER_HEADER);
  let userId: string;
  if (marked) {
    const session = await checkExpectedSession(request);
    if (!session.ok) return expectedSessionFailure(session.status);
    userId = session.identity.user.id;
  } else {
    const user = await requireUser(request.headers.get("cookie"));
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
  }

  const { runId } = await context.params;

  // Verify run ownership - only allow stopping runs created by this user
  // Fail-closed: if ownership is unknown (not in DB), deny access
  let owner: Awaited<ReturnType<typeof getRunOwner>>;
  let owns: boolean;
  try {
    owner = await getRunOwner(runId);
    owns = !!owner && (await isRunOwner(runId, userId));
  } catch (err) {
    if (marked) return proxyError();
    throw err;
  }
  if (!owner) {
    return Response.json({ error: "Forbidden: run ownership unknown" }, { status: 403 });
  }
  if (!owns) {
    return Response.json({ error: "Forbidden: not run owner" }, { status: 403 });
  }
  
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
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
    if (marked) return proxyError();
    return Response.json(
      { error: err instanceof Error ? err.message : "Proxy error" },
      { status: 502 }
    );
  }
}
