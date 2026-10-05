/**
 * Proxy for orchestrator runs endpoint.
 * The browser cannot access the orchestrator directly in Docker.
 */

import { NextRequest } from "next/server";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

export async function POST(request: NextRequest) {
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
