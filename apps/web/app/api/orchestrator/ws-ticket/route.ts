/**
 * Mints a short-lived WebSocket handshake ticket.
 *
 * GET /api/orchestrator/ws-ticket?runId=...
 *   401 without a session, 403 when the caller does not own the run
 *   (fail-closed when ownership is unknown), else `{ ticket, expiresAt }`
 *   scoped `run:<runId>`.
 * GET /api/orchestrator/ws-ticket?scope=runs
 *   401 without a session, else a ticket scoped `runs` for the global runs
 *   feed (`/api/ws/runs`). No ownership check: the feed carries exactly what
 *   the session-only GET /api/orchestrator/runs/active already exposes.
 * 400 when neither (or both, or an unknown scope) is given.
 *
 * The service token is only the HMAC key; it is never returned. See
 * lib/orchestrator/ws-ticket.ts and docs/SECURITY.md.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../lib/auth/require-user";
import { isRunOwner, getRunOwner } from "../../../../lib/editor/run-ownership";
import { mintWsTicket, resolveTicketRequest, wsTicketSecret } from "../../../../lib/orchestrator/ws-ticket";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const target = resolveTicketRequest(request.nextUrl.searchParams);
  if (target.kind === "invalid") {
    return Response.json({ error: target.error }, { status: 400, headers: NO_STORE });
  }

  if (target.kind === "run") {
    // Same ownership gate as /api/orchestrator/runs/[runId]: unknown owner denies.
    const owner = await getRunOwner(target.runId);
    if (!owner) {
      return Response.json({ error: "Forbidden: run ownership unknown" }, { status: 403, headers: NO_STORE });
    }
    if (!(await isRunOwner(target.runId, user.id))) {
      return Response.json({ error: "Forbidden: not run owner" }, { status: 403, headers: NO_STORE });
    }
  }

  try {
    const { ticket, expiresAt } = mintWsTicket(target.scope, { secret: wsTicketSecret() });
    return Response.json({ ticket, expiresAt }, { headers: NO_STORE });
  } catch {
    // Empty secret: fail closed without leaking configuration details.
    return Response.json({ error: "WebSocket tickets unavailable" }, { status: 503, headers: NO_STORE });
  }
}
