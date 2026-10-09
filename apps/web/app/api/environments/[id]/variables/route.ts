// k6flow-variables V-T2: read (masked) and replace an environment's variables.

import { requireUser } from "../../../../../lib/auth/require-user";
import { jsonError } from "../../../../../lib/auth/http";
import { parseVariableSetBody } from "../../../../../lib/variables/validation";
import {
  getEnvironmentVariables,
  replaceEnvironmentVariables,
  storeFailureResponse,
} from "../../../../../lib/variables/store";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/environments/[id]/variables — secrets masked as { name, secret, hasValue }
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const result = await getEnvironmentVariables(user, id);
    if (!result.ok) {
      return storeFailureResponse(result, "Environment");
    }
    return Response.json({ variables: result.value }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to read environment variables:", e);
    return jsonError(500, "Internal server error");
  }
}

// PUT /api/environments/[id]/variables — replace the full set { variables: [...] }
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  const parsed = parseVariableSetBody(body);
  if (!parsed.ok) {
    return storeFailureResponse({ ok: false, reason: "invalid", errors: parsed.errors }, "Environment");
  }

  try {
    const result = await replaceEnvironmentVariables(user, id, parsed.items);
    if (!result.ok) {
      return storeFailureResponse(result, "Environment");
    }
    return Response.json({ variables: result.value }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to replace environment variables:", e);
    return jsonError(500, "Internal server error");
  }
}
