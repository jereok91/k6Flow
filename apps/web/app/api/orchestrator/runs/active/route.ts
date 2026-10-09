import { NextRequest } from "next/server";
import { requireUser } from "../../../../../lib/auth/require-user";
import { orchestratorAuthHeaders, orchestratorBaseUrl } from "../../../../../lib/orchestrator/proxy";

export async function GET(request: NextRequest) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(`${orchestratorBaseUrl()}/api/runs/active`, {
      method: "GET",
      headers: orchestratorAuthHeaders(),
    });
  } catch {
    return Response.json({ error: "Failed to connect to orchestrator" }, { status: 502 });
  }

  // Pass the orchestrator status and body through unchanged.
  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}
