// K6F4-03: DELETE /api/users/{id} and PATCH /api/users/{id} — admin only.
//
// Gate + DB-error contract identical to the sibling route.ts (401/403/500,
// see admin-gate.ts). Lockout guards (DECISIONES.md §K6F4-03): an admin must
// NOT delete their own account or change their own role — either would lock
// the acting admin out of the admin surface; both are rejected with 400
// before any DB mutation.
import { eq } from "drizzle-orm";
import { jsonError } from "../../../../lib/auth/http";
import { toSafeUser } from "../../../../lib/auth/safe-user";
import { getDb } from "../../../../lib/db/client";
import { users } from "../../../../lib/db/schema";
import { resolveAdmin } from "../admin-gate";
import { checkDeleteTarget, checkRoleChangeTarget, parsePatchRoleBody } from "../logic";

// Next 15+/16 App Router: route params arrive as a Promise — must be awaited.
type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const gate = await resolveAdmin(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;

  let target;
  try {
    const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    target = row ?? null;
  } catch {
    return jsonError(500, "Internal server error");
  }
  if (target === null) return jsonError(404, "User not found");

  // Self-delete guard: prevents locking yourself out of the admin surface.
  if (checkDeleteTarget(gate.user.id, id) === "self") {
    return jsonError(400, "You cannot delete your own account");
  }

  try {
    await getDb().delete(users).where(eq(users.id, id));
  } catch {
    return jsonError(500, "Internal server error");
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await resolveAdmin(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;

  let parsed;
  try {
    parsed = parsePatchRoleBody(await request.json());
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  if (!parsed.ok) return jsonError(400, parsed.error);

  let target;
  try {
    const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    target = row ?? null;
  } catch {
    return jsonError(500, "Internal server error");
  }
  if (target === null) return jsonError(404, "User not found");

  // Self-role-change guard: ANY self-targeted role change is rejected
  // (including a no-op to the same role) — one simple rule that can never
  // accidentally demote the acting admin to a locked-out state.
  if (checkRoleChangeTarget(gate.user.id, id) === "self") {
    return jsonError(400, "You cannot change your own role");
  }

  let updated;
  try {
    const [row] = await getDb()
      .update(users)
      .set({ role: parsed.role })
      .where(eq(users.id, id))
      .returning();
    updated = row;
  } catch {
    return jsonError(500, "Internal server error");
  }
  // 200 + the updated SafeUser shape; the passwordHash never leaves the server.
  return new Response(JSON.stringify(toSafeUser(updated)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
