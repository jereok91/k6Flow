/**
 * Proxy for orchestrator runs endpoint.
 * The browser cannot access the orchestrator directly in Docker.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../lib/auth/require-user";
import { setRunOwner } from "../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

export async function POST(request: NextRequest) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.text();

    // Track run ownership if creation succeeded
    if (res.ok) {
      try {
        const runData = JSON.parse(data);
        if (runData.id) {
          await setRunOwner(runData.id, user.id);
        }
      } catch {
        // Ignore parse errors - the run may have been created without proper JSON
      }
    }

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
