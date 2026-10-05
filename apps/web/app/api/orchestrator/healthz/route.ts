/**
 * Proxy for orchestrator health check.
 * The browser cannot access the orchestrator directly in Docker.
 */

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";

export async function GET() {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      return Response.json({ status: "ok" });
    }

    return Response.json({ status: "error" }, { status: 503 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
