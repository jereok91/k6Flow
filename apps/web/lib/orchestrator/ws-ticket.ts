/**
 * Short-lived WebSocket handshake tickets (server-only; uses node:crypto).
 *
 * Browsers must never receive the orchestrator service token. Instead the
 * `GET /api/orchestrator/ws-ticket` route checks the session (and run
 * ownership for `?runId=`), then mints a ticket the browser presents as
 * `?ticket=` on the same-origin `/api/ws/runs/{runId}` proxy path, or on
 * `/api/ws/runs` for the global runs feed (`?scope=runs`). The orchestrator verifies it
 * in apps/orchestrator/internal/live/ticket.go.
 *
 * Format: `v1.<scope>.<expUnixSeconds>.<nonce>.<sigBase64url>` where sig is
 * the unpadded base64url HMAC-SHA256 (key = service token) of
 * `v1.<scope>.<exp>.<nonce>`. The ticket only opens the socket; an
 * established socket outlives the ticket.
 */

import { createHmac, randomBytes } from "node:crypto";

export const WS_TICKET_TTL_SECONDS = 60;

export interface MintWsTicketOptions {
  /** HMAC key: the shared orchestrator service token. Empty fails closed. */
  secret: string;
  /** Current time in epoch milliseconds (defaults to Date.now()). */
  now?: number;
  /** Ticket lifetime in seconds (defaults to 60). */
  ttlSeconds?: number;
  /** Test hook: fixed nonce. Production callers leave it unset. */
  nonce?: string;
}

export interface WsTicket {
  ticket: string;
  /** Expiry in epoch milliseconds. */
  expiresAt: number;
}

/** Scope authorizing `/ws/runs/{runId}`. */
export function runTicketScope(runId: string): string {
  return `run:${runId}`;
}

/** Scope authorizing the global runs feed `/ws/runs`. */
export const RUNS_TICKET_SCOPE = "runs";

export type TicketRequest =
  | { kind: "runs"; scope: typeof RUNS_TICKET_SCOPE }
  | { kind: "run"; runId: string; scope: string }
  | { kind: "invalid"; error: string };

/**
 * Resolves the ticket route's query: `?scope=runs` (global feed) or
 * `?runId=` (one run). Unknown scopes and the ambiguous combination of both
 * are rejected so a caller can never widen a per-run request.
 */
export function resolveTicketRequest(params: URLSearchParams): TicketRequest {
  const scope = params.get("scope");
  const runId = params.get("runId");
  if (scope !== null) {
    if (scope !== RUNS_TICKET_SCOPE) return { kind: "invalid", error: "unsupported scope" };
    if (runId) return { kind: "invalid", error: "scope and runId are mutually exclusive" };
    return { kind: "runs", scope: RUNS_TICKET_SCOPE };
  }
  if (!runId) return { kind: "invalid", error: "runId or scope=runs is required" };
  return { kind: "run", runId, scope: runTicketScope(runId) };
}

/**
 * HMAC key for tickets: the orchestrator service token, read at call time.
 * Fails closed: there is deliberately no default, because a publicly known
 * fallback key would let anyone forge tickets. Unset -> "" -> minting throws.
 */
export function wsTicketSecret(): string {
  return process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "";
}

export function mintWsTicket(scope: string, options: MintWsTicketOptions): WsTicket {
  const { secret, now = Date.now(), ttlSeconds = WS_TICKET_TTL_SECONDS } = options;
  if (!secret) throw new Error("ws ticket: empty secret");
  if (!scope) throw new Error("ws ticket: empty scope");
  if (!(ttlSeconds > 0)) throw new Error("ws ticket: ttl must be positive");

  const exp = Math.floor(now / 1000) + Math.floor(ttlSeconds);
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const signed = `v1.${scope}.${exp}.${nonce}`;
  const sig = createHmac("sha256", secret).update(signed).digest("base64url");
  return { ticket: `${signed}.${sig}`, expiresAt: exp * 1000 };
}
