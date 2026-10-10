// GET /api/auth/me: top-level SafeUser fields plus a non-credential session marker.
// DB failures (including expired-row deletion) are generic 500, never 401;
// neither the original error nor credentials are logged or echoed.
import { jsonError } from "../../../../lib/auth/http";
import { requireSessionIdentity } from "../../../../lib/auth/require-user";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const identity = await requireSessionIdentity(request.headers.get("cookie"));
    response = identity === null
      ? jsonError(401, "Unauthorized")
      : Response.json({ ...identity.user, sessionMarker: identity.sessionMarker });
  } catch {
    response = jsonError(500, "Internal server error");
  }
  // All probe outcomes are private and must not be cached, including failures.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
