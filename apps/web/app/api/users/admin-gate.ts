// K6F4-03: shared admin gate for the /api/users route handlers. DB-bound
// glue (requireUser resolves the session server-side), so — like
// lib/auth/require-user.ts itself — it is NOT unit-tested here; the pure
// decision half (classifyAdminAccess) is pinned in logic.test.ts and the
// DB-backed session resolution is proven in the K6F4-06 real-stack e2e.
//
// Contract: 401 = no valid session (log in), 403 = authenticated but not
// admin, 500 = DB failure inside requireUser — never 401/403 (an outage must
// not masquerade as an auth problem). Error internals are never logged.
import { jsonError } from "../../../lib/auth/http";
import { requireUser } from "../../../lib/auth/require-user";
import type { SafeUser } from "../../../lib/auth/safe-user";
import { classifyAdminAccess } from "./logic";

export type AdminGateResult =
  | { ok: true; user: SafeUser }
  | { ok: false; response: Response };

export async function resolveAdmin(request: Request): Promise<AdminGateResult> {
  let user: SafeUser | null;
  try {
    user = await requireUser(request.headers.get("cookie"));
  } catch {
    return { ok: false, response: jsonError(500, "Internal server error") };
  }
  const gate = classifyAdminAccess(user);
  if (gate === "unauthorized") return { ok: false, response: jsonError(401, "Unauthorized") };
  if (gate === "forbidden") return { ok: false, response: jsonError(403, "Forbidden") };
  // classifyAdminAccess returns "ok" only for a non-null admin.
  return { ok: true, user: user as SafeUser };
}
