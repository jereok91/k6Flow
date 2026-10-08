// Proxy to orchestrator: GET /runs/:runId/failures
import { NextRequest } from "next/server";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8080";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const { runId } = await params;
  
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/runs/${runId}/failures`, {
      headers: { Accept: "application/json" },
    });
    
    if (!res.ok) {
      return Response.json(
        { error: "Failed to fetch failures", failures: [] },
        { status: res.status }
      );
    }
    
    const data = await res.json();
    return Response.json(data);
  } catch {
    // Return empty failures on error
    return Response.json({ version: 1, failures: [] });
  }
}
