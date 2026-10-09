// Proxy to orchestrator: GET /api/runs/:runId/failures
import { NextRequest } from "next/server";
import { requireUser } from "../../../../../../lib/auth/require-user";
import { isRunOwner, getRunOwner } from "../../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;

  // Verify run ownership
  const owner = await getRunOwner(runId);
  if (!owner) {
    // Run not in DB - might be a new run, allow access
  } else if (!(await isRunOwner(runId, user.id))) {
    return Response.json({ error: "Forbidden: not run owner" }, { status: 403 });
  }
  
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}/failures`, {
      headers: { 
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
        "Accept": "application/json",
      },
    });
    
    if (!res.ok) {
      return Response.json(
        { version: 1, failures: [] },
        { status: 200 } // Return empty list on error, not the error status
      );
    }
    
    const data = await res.json();
    return Response.json(data);
  } catch {
    // Return empty failures on error
    return Response.json({ version: 1, failures: [] });
  }
}
