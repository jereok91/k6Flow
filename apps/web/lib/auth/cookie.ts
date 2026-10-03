// K6F4-02a: pure Set-Cookie / Cookie-header helpers. NO next/headers import —
// this module must run in the vitest node env; the request adapter lives in
// the route handlers (K6F4-02b).

export const SESSION_COOKIE = "k6flow_session";

// SameSite=Lax justification: Lax allows top-level-navigation logins (a
// first-party redirect flow after login still sends the cookie) while
// blocking cross-site POST CSRF (state-changing cross-site requests omit the
// cookie). Strict would break first-party redirect flows — e.g. OAuth-style
// return hops or in-app cross-route redirects — because the cookie is
// withheld on cross-site navigations.
//
// The caller decides `secure` from the request protocol: HTTPS detection
// belongs in the route handlers (request URL / x-forwarded-proto), not here.
// `secure=false` keeps the cookie usable over plain-HTTP local dev.
export function serializeSessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

// Extract the session token from a Cookie header. Missing/malformed → null.
// Values are matched exactly on the cookie NAME; unrelated cookies are
// ignored. A bare cookie name with an empty value counts as malformed.
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const segment of cookieHeader.split(";")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = segment.slice(eq + 1).trim();
    if (value.length === 0) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null; // malformed percent-encoding → treat as no session
    }
  }
  return null;
}
