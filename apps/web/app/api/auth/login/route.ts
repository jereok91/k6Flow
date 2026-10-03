// K6F4-02b: POST /api/auth/login — credential check + session cookie.
//
// DB-error contract (02a→02b risk handoff): a getDb()/query throw — including
// anything inside createSession — is a SERVER error, never an auth failure.
// Such errors return jsonError(500, "Internal server error") with a generic
// body; the original error message/stack is neither logged nor echoed (these
// paths can carry password material, so nothing is written to logs either).
import { eq } from "drizzle-orm";
import { serializeSessionCookie } from "../../../../lib/auth/cookie";
import { jsonError, parseLoginBody } from "../../../../lib/auth/http";
import { toSafeUser } from "../../../../lib/auth/safe-user";
import { createSession, resolveSessionTtlSeconds } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/client";
import { verifyPassword } from "../../../../lib/db/password";
import { users, type User } from "../../../../lib/db/schema";
import { classifyLogin, INVALID_CREDENTIALS, isRequestHttps } from "../logic";

export async function POST(request: Request): Promise<Response> {
  // Shape-only validation (02a). parseLoginBody is synchronous; values are
  // returned raw — do NOT re-trim the password before verifyPassword.
  const parsed = parseLoginBody(await request.text());
  if (!parsed.ok) return jsonError(400, parsed.error);
  const { username, password } = parsed;

  // Single select by username. DB failure → 500, never a misleading 401.
  let user: User | null;
  try {
    const db = getDb();
    const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    user = rows[0] ?? null;
  } catch {
    return jsonError(500, "Internal server error");
  }

  // Anti-enumeration: unknown user and wrong password collapse to ONE
  // classification → one identical 401 body+status. The user===null check is
  // TS narrowing only; classifyLogin also maps null to invalid-credentials.
  if (user === null || classifyLogin(user, password, verifyPassword) !== "ok") {
    return jsonError(401, INVALID_CREDENTIALS);
  }

  const secure = isRequestHttps(request.headers, request.url);
  let token: string;
  try {
    token = await createSession(user.id);
  } catch {
    return jsonError(500, "Internal server error");
  }

  // TTL source: same resolver createSession uses internally — never a
  // hardcoded duplicate that could drift from the row's expiresAt.
  const maxAgeSeconds = resolveSessionTtlSeconds(process.env);
  return new Response(JSON.stringify(toSafeUser(user)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": serializeSessionCookie(token, { secure, maxAgeSeconds }),
    },
  });
}
