import { parseSessionCookie } from "./cookie";
import { getSessionUser } from "./session";
import type { SafeUser } from "./safe-user";

// K6F4-02a: thin wrapper — parse the Cookie header, resolve the session
// server-side. Returns null when unauthenticated (missing/invalid cookie,
// missing or expired session row). NOT wired into middleware here; K6F4-02c
// owns that. The DB-backed resolution is proven in the K6F4-06 e2e, not in
// unit tests.
export async function requireUser(
  cookieHeader: string | null | undefined,
): Promise<SafeUser | null> {
  const token = parseSessionCookie(cookieHeader);
  if (token === null) return null;
  return getSessionUser(token);
}

// Role gate: true only for a non-null user whose role is exactly "admin".
export function requireAdmin(user: SafeUser | null): boolean {
  return user !== null && user.role === "admin";
}
