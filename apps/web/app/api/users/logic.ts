// K6F4-03: pure decision helpers for the admin user-management routes.
// Mirrors the K6F4-02b pattern (api/auth/logic.ts): every security-relevant
// branch lives here so it is unit-testable without a Next server or a DB;
// route handlers stay thin wrappers around these + the reviewed 02a/02b
// helpers (requireUser/requireAdmin, jsonError, toSafeUser, hashPassword).
//
// DB boundary: this module contains NO database calls. The DB-backed paths
// (actual insert/delete/update/list, unique-constraint conflict mapping) are
// proven in the K6F4-06 real-stack e2e, not in unit tests.
import { toSafeUser } from "../../../lib/auth/safe-user";
import type { SafeUser } from "../../../lib/auth/safe-user";
import type { User } from "../../../lib/db/schema";

// Admin gate decision (single pure classifier). 401 vs 403 distinction
// (documented in DECISIONES.md §K6F4-03): "unauthorized" = no valid session
// at all → jsonError(401) "the client should log in"; "forbidden" = a valid
// session whose role is not admin → jsonError(403) "the client should not
// retry with the same credentials". Both statuses reveal nothing beyond the
// caller's own session state; the routes do NOT distinguish further (e.g.
// never echo which role was seen).
export type AdminGate = "ok" | "unauthorized" | "forbidden";

export function classifyAdminAccess(user: SafeUser | null): AdminGate {
  if (user === null) return "unauthorized";
  return user.role === "admin" ? "ok" : "forbidden";
}

// Password minimum reused from the seed CLI (apps/web/scripts/seed.ts:
// ADMIN_PASSWORD must be >= 12 characters). One policy, one number — an
// admin-created account must never be weaker than the seeded admin; a future
// change to the floor updates both call sites together.
export const MIN_PASSWORD_LENGTH = 12;

export type CreateUserParse =
  | { ok: true; username: string; password: string; role: "admin" | "user" }
  | { ok: false; error: string };

export const INVALID_ROLE_ERROR = `role must be exactly "admin" or "user"`;

function parseRole(value: unknown): "admin" | "user" | null {
  return value === "admin" || value === "user" ? value : null;
}

// POST /api/users body validation. Blank checks use trim (a blank username
// is invalid) but values are returned RAW — the password is hashed exactly
// as sent (it may legitimately contain leading/trailing spaces), matching
// parseLoginBody's rule in K6F4-02a.
export function parseCreateUserBody(body: unknown): CreateUserParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const { username, password, role } = body as Record<string, unknown>;
  if (typeof username !== "string" || username.trim().length === 0) {
    return { ok: false, error: "username must be a non-blank string" };
  }
  // Same order and raw-length rule as the seed CLI: blank first, then
  // length < MIN_PASSWORD_LENGTH on the raw string.
  if (typeof password !== "string" || password.trim().length === 0) {
    return { ok: false, error: "password must be a non-blank string" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length})`,
    };
  }
  const parsedRole = parseRole(role);
  if (parsedRole === null) return { ok: false, error: INVALID_ROLE_ERROR };
  return { ok: true, username, password, role: parsedRole };
}

export type PatchRoleParse =
  | { ok: true; role: "admin" | "user" }
  | { ok: false; error: string };

// PATCH /api/users/{id} body validation — role only, same exact-value rule.
export function parsePatchRoleBody(body: unknown): PatchRoleParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const { role } = body as Record<string, unknown>;
  const parsedRole = parseRole(role);
  if (parsedRole === null) return { ok: false, error: INVALID_ROLE_ERROR };
  return { ok: true, role: parsedRole };
}

// Lockout guards (documented in DECISIONES.md §K6F4-03): an admin must not
// delete their own account or demote their own role — either would lock the
// acting admin out of the admin surface (a lone self-demote leaves zero
// admins). The routes reject with 400 BEFORE any DB access.
export type SelfActionCheck = "ok" | "self";

export function checkDeleteTarget(actorId: string, targetId: string): SelfActionCheck {
  return actorId === targetId ? "self" : "ok";
}

export function checkRoleChangeTarget(actorId: string, targetId: string): SelfActionCheck {
  return actorId === targetId ? "self" : "ok";
}

// SafeUser mapping for user-management responses (list/create/update).
// Reuses the reviewed K6F4-02a mapper; the list wrapper exists so every
// response body flows through ONE choke point the unit tests pin — the
// passwordHash field must be unrepresentable in every admin API response.
export function toSafeUserList(rows: User[]): SafeUser[] {
  return rows.map(toSafeUser);
}
