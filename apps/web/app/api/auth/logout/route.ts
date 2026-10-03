// K6F4-02b: POST /api/auth/logout — revoke + clear cookie. Idempotent: a
// missing/invalid/expired cookie still returns the same 200 body; the
// response never reveals whether a cookie was present.
//
// DB-error contract: a getDb()/revokeSession throw is a server error. The
// task spec routes DB failures to jsonError(500, "Internal server error"),
// so this handler builds that body inline — jsonError cannot attach extra
// headers. The cleared Set-Cookie is attached on BOTH paths so the client
// drops the cookie even when revocation fails (defense in depth). Flagged for
// parent review: the 500 body+headers are otherwise identical to a 200 with
// no cookie, so this choice trades response-shape uniformity for cookie
// hygiene; if the parent prefers strict jsonError semantics, drop the
// Set-Cookie from the 500 branch.
import { parseSessionCookie } from "../../../../lib/auth/cookie";
import { jsonError } from "../../../../lib/auth/http";
import { revokeSession } from "../../../../lib/auth/session";
import { buildClearedCookie, isRequestHttps } from "../logic";

export async function POST(request: Request): Promise<Response> {
  const token = parseSessionCookie(request.headers.get("cookie"));
  const cleared = buildClearedCookie(isRequestHttps(request.headers, request.url));

  if (token !== null) {
    try {
      // Idempotent delete (02a): revoking an unknown/expired token is a no-op.
      await revokeSession(token);
    } catch {
      const failure = jsonError(500, "Internal server error");
      failure.headers.set("Set-Cookie", cleared);
      return failure;
    }
  }

  // 200 with the healthz-style body whether or not a cookie was present.
  const response = Response.json({ status: "ok" }, { status: 200 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Set-Cookie", cleared);
  return response;
}
