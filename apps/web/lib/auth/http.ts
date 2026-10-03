// K6F4-02a: tiny JSON error helper + login-body validation shared by the 02b
// route handlers so every error path has one consistent shape.

// Consistent error body: `{ error: message }` with a JSON content type.
export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export type ParseLoginResult =
  | { ok: true; username: string; password: string }
  | { ok: false; error: string };

// Anti-enumeration rationale: this validator intentionally does NOT
// distinguish "unknown user" from "wrong password" — it only validates shape.
// The 02b login route MUST return one identical 401 body for both cases
// (enforced there, noted here) so responses cannot be used to probe which
// usernames exist. Values are returned raw; blank-checks use trim but never
// mutate what the route verifies against (passwords may legitimately contain
// leading/trailing spaces).
export function parseLoginBody(text: string): ParseLoginResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || username.trim().length === 0) {
    return { ok: false, error: "username must be a non-blank string" };
  }
  if (typeof password !== "string" || password.trim().length === 0) {
    return { ok: false, error: "password must be a non-blank string" };
  }
  return { ok: true, username, password };
}
