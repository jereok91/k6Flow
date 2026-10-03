// K6F4-02b: pure decision helpers extracted from the auth route handlers so
// the security-relevant branches are unit-testable without a Next server or a
// DB. Route handlers stay thin wrappers around these + the K6F4-02a helpers.
import { serializeSessionCookie, SESSION_COOKIE } from "../../../lib/auth/cookie";

// Single anti-enumeration constant: the login route returns this exact message
// for BOTH "unknown user" and "wrong password". One string, one status → the
// response body/status pair cannot be used to probe which usernames exist.
export const INVALID_CREDENTIALS = "Invalid username or password";

export type LoginClassification = "ok" | "invalid-credentials";

// Anti-enumeration encoded as ONE branch: a missing user row and a failed
// password check collapse to the same classification, so the route maps both
// to the identical jsonError(401, INVALID_CREDENTIALS). `verify` is injected
// so tests can pin behavior without scrypt or a DB.
//
// Known residual risk (documented, not mitigated here): when the user does not
// exist the route never runs verifyPassword, so a nonexistent username is
// ~50-100 ms faster (no scrypt derivation) than a wrong password. The
// mitigation shipped in this unit is identical body + status; a timing
// equalizer (dummy verify against a fixed hash) is out of scope for K6F4-02b.
//
// The password is passed to `verify` exactly as parsed — NEVER re-trimmed.
// parseLoginBody blank-checks with trim but returns raw values; re-trimming
// here would reject passwords with intentional leading/trailing spaces.
export function classifyLogin(
  user: { passwordHash: string } | null,
  password: string,
  verify: (plain: string, stored: string) => boolean,
): LoginClassification {
  if (user === null) return "invalid-credentials";
  return verify(password, user.passwordHash) ? "ok" : "invalid-credentials";
}

// HTTPS detection for the Secure cookie flag ONLY. Precedence:
//   1. `x-forwarded-proto` when present — the first comma-separated value wins
//      (proxies append the original client proto first). It is treated as
//      authoritative because the app server's own request URL usually reports
//      the internal proto (http behind TLS-terminating proxy).
//   2. Otherwise the request URL protocol (Next Request.url).
//   3. Otherwise false (plain-HTTP local dev keeps working).
// This heuristic affects ONLY whether Set-Cookie carries `Secure`; it never
// authorizes a request. Malformed URLs never throw.
export function isRequestHttps(headers: Headers, requestUrl?: string | URL): boolean {
  const forwardedProto = headers.get("x-forwarded-proto");
  if (forwardedProto !== null) {
    const first = forwardedProto.split(",")[0]?.trim().toLowerCase() ?? "";
    return first === "https";
  }
  if (requestUrl === undefined) return false;
  try {
    const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// Deletion Set-Cookie for logout. Reuses serializeSessionCookie with an empty
// value and maxAgeSeconds=0, which yields
//   `k6flow_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax[; Secure]`
// A deletion cookie is defined by matching name + Path with zero expiry; the
// empty value is harmless because the browser discards the cookie rather than
// storing it. Reusing the serializer keeps the flag set (HttpOnly, Path=/,
// SameSite=Lax, conditional Secure) in ONE place — a hand-rolled cleared
// cookie could drift from the live cookie's flags and fail to delete it.
export function buildClearedCookie(secure: boolean): string {
  return serializeSessionCookie("", { secure, maxAgeSeconds: 0 });
}

// Re-export for tests asserting the cookie NAME matches the live cookie.
export { SESSION_COOKIE };
