import {
  getBrowserSessionInvalidationHub,
  type SessionInvalidationHub,
} from "./session-invalidation";

// A completion hint requests fresh revalidation; it never grants authentication
// or permission to reuse cached session/diagnostic context.
export async function mutateSession<T extends { ok: boolean }>(
  kind: "login" | "logout",
  request: () => Promise<T>,
  hub: Pick<SessionInvalidationHub, "invalidate"> = getBrowserSessionInvalidationHub(),
): Promise<T> {
  hub.invalidate("begin");
  const response = await request();
  // Logout clears the cookie even on a resolved revocation-failure response.
  // Rejection is uncertain: propagate it without inventing completion.
  if (kind === "logout" || response.ok) hub.invalidate("complete");
  return response;
}
