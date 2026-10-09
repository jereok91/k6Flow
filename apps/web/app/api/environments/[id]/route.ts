// k6flow-variables V-T2: rename or delete one of the user's environments.

import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { parseEnvironmentName } from "../../../../lib/variables/validation";
import { deleteEnvironment, renameEnvironment, storeFailureResponse } from "../../../../lib/variables/store";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// PATCH /api/environments/[id] — rename { name }
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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

  const parsed = parseEnvironmentName(body);
  if (!parsed.ok) {
    return jsonError(400, parsed.message);
  }

  try {
    const result = await renameEnvironment(user, id, parsed.name);
    if (!result.ok) {
      return storeFailureResponse(result, "Environment");
    }
    return Response.json(result.value, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to rename environment:", e);
    return jsonError(500, "Internal server error");
  }
}

// DELETE /api/environments/[id] — delete with its variables
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const result = await deleteEnvironment(user, id);
    if (!result.ok) {
      return storeFailureResponse(result, "Environment");
    }
    return Response.json({ id, deleted: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to delete environment:", e);
    return jsonError(500, "Internal server error");
  }
}
