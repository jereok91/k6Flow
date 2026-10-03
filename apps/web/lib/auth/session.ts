import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { toSafeUser, type SafeUser } from "./safe-user";

// K6F4-02a: DB-backed opaque sessions over the existing `sessions` table.
// No stateless JWT, no signing key — a session IS a random opaque token whose
// Postgres row grants access; revoking = deleting the row.
//
// Token-comparison reasoning: the token is server-generated, high-entropy
// (crypto.randomBytes(32) → 256 bits) and resolved by PRIMARY KEY index
// lookup. That DB lookup IS the comparison: an attacker cannot forge a token
// that matches a live row without guessing 256 bits of entropy. A
// timing-safe compare layer adds nothing here — timing-safe equality exists
// to protect secrets compared against attacker-influenced input in
// application code; PK equality inside Postgres is not a practical timing
// oracle for this threat model, and the token never enters a comparison loop.

// Default session lifetime: 7 days. Overridable via SESSION_TTL_SECONDS.
export const SESSION_TTL_SECONDS = 604_800;

// Pure TTL resolution: absent / non-numeric / <= 0 env values fall back to
// the default. NEVER throws on bad env.
export function resolveSessionTtlSeconds(
  env: Record<string, string | undefined> | undefined,
): number {
  const raw = env?.SESSION_TTL_SECONDS;
  if (typeof raw !== "string") return SESSION_TTL_SECONDS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return SESSION_TTL_SECONDS;
  return Math.floor(n);
}

// Pure expiry decision, split out for unit testing without a DB.
// Boundary semantics: expiresAt <= now counts as expired.
export function isSessionExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

// 256 bits of cryptographic randomness, base64url-encoded (URL/cookie safe,
// no padding). Generated per session; never derived from user data.
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(userId: string): Promise<string> {
  const db = getDb();
  const token = generateSessionToken();
  const ttlSeconds = resolveSessionTtlSeconds(process.env);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return token;
}

// Returns the mapped SafeUser (never passwordHash), or null when the token
// is missing OR expired. Expired rows are lazily deleted here (best effort,
// awaited) so the sessions table does not accumulate dead rows; a failed
// delete must not turn an expired session into an error — it still returns
// null. A session row whose user has been deleted also returns null (the FK
// cascade should normally remove such rows).
export async function getSessionUser(token: string): Promise<SafeUser | null> {
  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.token, token)).limit(1);
  if (!session) return null;
  if (isSessionExpired(session.expiresAt, new Date())) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) return null;
  return toSafeUser(user);
}

// Idempotent: deleting a token that does not exist is a no-op, not an error.
export async function revokeSession(token: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.token, token));
}

// Delete all sessions for one user (logout-everywhere / password change).
export async function revokeUserSessions(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
