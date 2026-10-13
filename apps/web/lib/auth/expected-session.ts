import { timingSafeEqual } from "node:crypto";
import { requireSessionIdentity } from "./require-user";
import type { SessionIdentity } from "./session";

// Binds a request to the session the client expects to still be live. The
// marker is NOT a credential: authentication still comes from the cookie
// session. Never echo, log or persist either marker.
export const SESSION_MARKER_HEADER = "X-K6Flow-Session-Marker";
const MARKER_PATTERN = /^[a-f0-9]{64}$/;

export type ExpectedSessionResult =
  | { ok: true; identity: SessionIdentity }
  | { ok: false; status: ExpectedSessionFailureStatus };
export type ExpectedSessionFailureStatus = 401 | 412 | 503;

export async function checkExpectedSession(request: Pick<Request, "headers">): Promise<ExpectedSessionResult> {
  let identity: SessionIdentity | null;
  try {
    identity = await requireSessionIdentity(request.headers.get("cookie"));
  } catch {
    // DB errors can carry query params (the raw cookie token): never surface
    // or log them; fail closed with a fixed body.
    return { ok: false, status: 503 };
  }
  if (identity === null) return { ok: false, status: 401 };
  const expected = request.headers.get(SESSION_MARKER_HEADER);
  if (expected === null || !MARKER_PATTERN.test(expected) || !MARKER_PATTERN.test(identity.sessionMarker)) {
    return { ok: false, status: 412 };
  }
  // Both markers passed the 64-hex check, so the buffers have equal length.
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(identity.sessionMarker))) return { ok: false, status: 412 };
  return { ok: true, identity };
}

// Fixed, marker-free failure bodies; never cacheable.
const FAILURE_MESSAGES: Record<ExpectedSessionFailureStatus, string> = {
  401: "Unauthorized",
  412: "Session changed",
  503: "Session check unavailable",
};

export function expectedSessionFailure(status: ExpectedSessionFailureStatus): Response {
  return Response.json(
    { error: FAILURE_MESSAGES[status] },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
