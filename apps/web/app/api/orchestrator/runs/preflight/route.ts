import { NextRequest } from "next/server";
import { requireUser } from "../../../../../lib/auth/require-user";
import { orchestratorAuthHeaders, orchestratorBaseUrl } from "../../../../../lib/orchestrator/proxy";

export async function POST(request: NextRequest) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Forward the request body verbatim; the orchestrator validates it.
  const body = await request.text();

  let res: Response;
  try {
    res = await fetch(`${orchestratorBaseUrl()}/api/runs/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...orchestratorAuthHeaders(),
      },
      body,
    });
  } catch {
    return Response.json({ error: "Failed to connect to orchestrator" }, { status: 502 });
  }

  // Pass the orchestrator body through unchanged (including 422
  // `{version, code, message}` limit errors) instead of re-encoding it.
  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}
