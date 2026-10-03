// K6F4-02b: GET /api/auth/me — session probe returning the SafeUser.
//
// DB-error contract (the key 02a→02b risk handoff): requireUser → getSessionUser
// can throw from getDb(), including the lazy expired-row delete inside
// getSessionUser when a session is expired. That is a server error → 500
// generic body, NEVER a 401: a 401 would tell the client "log in again" when
// the server actually failed, masking outages as auth problems. The original
// error is not logged or echoed.
import { jsonError } from "../../../../lib/auth/http";
import { requireUser } from "../../../../lib/auth/require-user";
import type { SafeUser } from "../../../../lib/auth/safe-user";

export async function GET(request: Request): Promise<Response> {
  let user: SafeUser | null;
  try {
    // requireUser = parseSessionCookie + getSessionUser (both 02a).
    user = await requireUser(request.headers.get("cookie"));
  } catch {
    return jsonError(500, "Internal server error");
  }
  if (user === null) return jsonError(401, "Unauthorized");
  // Mirrors healthz: JSON + no-store (per-user data must not be cached).
  return Response.json(user, { headers: { "Cache-Control": "no-store" } });
}
