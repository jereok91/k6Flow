// k6flow-variables V-T2: list and create the current user's environments.

import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { parseEnvironmentName } from "../../../lib/variables/validation";
import { createEnvironment, listEnvironments, storeFailureResponse } from "../../../lib/variables/store";

// GET /api/environments — list the user's environments
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const list = await listEnvironments(user);
    return Response.json({ environments: list }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list environments:", e);
    return jsonError(500, "Internal server error");
  }
}

// POST /api/environments — create an environment { name }
export async function POST(request: Request): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  const parsed = parseEnvironmentName(body);
  if (!parsed.ok) {
    return jsonError(400, parsed.message);
  }

  try {
    const result = await createEnvironment(user, parsed.name);
    if (!result.ok) {
      return storeFailureResponse(result, "Environment");
    }
    return Response.json(result.value, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to create environment:", e);
    return jsonError(500, "Internal server error");
  }
}
