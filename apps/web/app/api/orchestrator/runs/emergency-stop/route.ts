import { NextRequest } from "next/server";
import { resolveAdmin } from "../../../users/admin-gate";
import { orchestratorAuthHeaders, orchestratorBaseUrl } from "../../../../../lib/orchestrator/proxy";

export async function POST(request: NextRequest) {
  // Emergency stop halts every active run across all users: admin only.
  // 401 = no session, 403 = authenticated non-admin, 500 = session DB failure.
  const gate = await resolveAdmin(request);
  if (!gate.ok) return gate.response;

  // Forward any request body verbatim (the current client sends none).
  const body = await request.text();
  const contentType = request.headers.get("Content-Type");

  let res: Response;
  try {
    res = await fetch(`${orchestratorBaseUrl()}/api/runs/emergency-stop`, {
      method: "POST",
      headers: {
        ...(body && contentType ? { "Content-Type": contentType } : {}),
        ...orchestratorAuthHeaders(),
      },
      body: body || undefined,
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
