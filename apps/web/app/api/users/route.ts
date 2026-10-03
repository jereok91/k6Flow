// K6F4-03: GET /api/users (list) and POST /api/users (create) — admin only.
//
// Gate contract (DECISIONES.md §K6F4-03): every handler resolves the session
// via the shared admin gate (requireUser → requireAdmin classification).
// 401 = no valid session (log in), 403 = authenticated but not admin —
// distinct statuses, no further distinction. DB errors are a generic 500,
// never 401/403; error internals are neither logged nor echoed (these paths
// carry password material).
import { randomUUID } from "node:crypto";
import { jsonError } from "../../../lib/auth/http";
import { toSafeUser } from "../../../lib/auth/safe-user";
import { getDb } from "../../../lib/db/client";
import { hashPassword } from "../../../lib/db/password";
import { users } from "../../../lib/db/schema";
import { resolveAdmin } from "./admin-gate";
import { parseCreateUserBody, toSafeUserList } from "./logic";

export async function GET(request: Request): Promise<Response> {
  const gate = await resolveAdmin(request);
  if (!gate.ok) return gate.response;

  let rows;
  try {
    rows = await getDb().select().from(users);
  } catch {
    return jsonError(500, "Internal server error");
  }
  // toSafeUserList is the single mapping choke point — passwordHash can
  // never reach the response body (pinned by logic.test.ts).
  return Response.json(
    { users: toSafeUserList(rows) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const gate = await resolveAdmin(request);
  if (!gate.ok) return gate.response;

  let parsed;
  try {
    parsed = parseCreateUserBody(await request.json());
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  if (!parsed.ok) return jsonError(400, parsed.error);

  let created;
  try {
    // hashPassword is scrypt (K6F4-01b); the hash is inserted, NEVER echoed.
    const passwordHash = hashPassword(parsed.password);
    const [row] = await getDb()
      .insert(users)
      .values({
        id: randomUUID(),
        username: parsed.username,
        passwordHash,
        role: parsed.role,
      })
      .returning();
    created = row;
  } catch (error) {
    // Duplicate username → 409 via the DB unique constraint (pg code 23505).
    // Detection is constraint-driven only: no pre-check SELECT, so response
    // timing cannot be used to probe usernames beyond what the constraint
    // itself already reveals. Any other DB failure stays a generic 500.
    if ((error as { code?: string }).code === "23505") {
      return jsonError(409, `username "${parsed.username}" is already taken`);
    }
    return jsonError(500, "Internal server error");
  }

  // 201 + the SafeUser shape; the passwordHash never leaves the server.
  return new Response(JSON.stringify(toSafeUser(created)), {
    status: 201,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
