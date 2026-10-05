/**
 * Proxy for orchestrator run stop endpoint.
 */

import { NextRequest } from "next/server";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}/stop`, {
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
    return Response.json(
      { error: err instanceof Error ? err.message : "Proxy error" },
      { status: 502 }
    );
  }
}
