# Metrics WebSocket contract (version 1)

`packages/shared/src/metrics-messages.ts` declares the run-scoped metrics frame with strict
Zod schemas and inferred types. This unit is declaration-only: no handlers, sockets, servers,
aggregation, broadcast or replay logic. The REST side is [runs.md](runs.md).

## Topic and routing

| Item | Contract |
|------|----------|
| Topic | `/ws/runs/{runId}` — one run-scoped stream of metrics frames |
| Browser path | Same-origin `/api/ws/runs/{runId}` through a Next proxy rewrite to the orchestrator internal port |
| Exposure | The orchestrator port is not exposed; the browser never connects to it directly |

Routing is documentation only: no proxy, upgrade or socket code ships in this unit.

## Handshake authentication

The orchestrator rejects an unauthenticated handshake with HTTP 401 before the upgrade and
before looking up the run, so unauthenticated clients cannot probe which runs exist.

| Client | Credential | Rules |
|--------|------------|-------|
| Browser | `?ticket=<ticket>` on `/api/ws/runs/{runId}` | Short-lived signed ticket from the web app; the service token never reaches the browser |
| Server-side / non-browser | Subprotocols `["k6flow.bearer", "<service token>"]` | Constant-time compare; server echoes `k6flow.bearer` |

The raw service token is **not** accepted as a `?token=` query parameter. A token in a URL
leaks through browser history, proxy logs and client bundles.

### Browser tickets

1. Right before each connect or reconnect, the browser calls
   `GET /api/orchestrator/ws-ticket?runId={runId}`. The web route answers 401 without a session
   and 403 unless the caller owns the run. On success it returns `{ ticket, expiresAt }`, with
   `expiresAt` in epoch milliseconds.
2. The browser opens `ws(s)://<web host>/api/ws/runs/{runId}?ticket=<urlencoded ticket>`.
   It offers no subprotocol.
3. The orchestrator verifies the ticket against the scope `run:{runId}` taken from the path.

| Part | Value |
|------|-------|
| Format | `v1.<scope>.<expUnixSeconds>.<nonce>.<sig>` |
| Scope | `run:<runId>`. Matched exactly, so a ticket for one run never opens another |
| Expiry | 60 s TTL; the verifier allows 5 s of clock skew |
| Nonce | 16 random bytes, base64url |
| Signature | Unpadded base64url HMAC-SHA256 of `v1.<scope>.<exp>.<nonce>`, keyed with the shared service token |
| Failure | Malformed, bad signature, expired, wrong scope or empty configured secret → 401 |

The ticket only gates the handshake. An established socket is not closed when its ticket
expires. Minting: `apps/web/lib/orchestrator/ws-ticket.ts`. Verification:
`apps/orchestrator/internal/live/ticket.go`.

## Live message envelope

The orchestrator stream wraps each frame below in an envelope and adds lifecycle messages
(`apps/orchestrator/internal/live/messages.go`):

| `type` | Fields |
|--------|--------|
| `hello` | `status`, `lastSeq`, `startedAt` (epoch ms or null), `elapsedMs`; sent once on connect |
| `tick` | `seq`, `frame`; `frame` is the metrics frame contract below |
| `state` | `fromState`, `toState`, `at` (epoch ms), optional `actor`, `cause` |
| `end` | `status`, `result`, `exitCode`, optional `summary`, `finishedAt` (epoch ms) |

## Frame contract

Exactly one message type exists here; the discriminated union is closed to `type: "metrics"`.
Terminal, error and reconnect/replay frames are a deferred, distinct capability and must not
appear in this union. Unknown fields are rejected at every object level.

| Field | Type | Rules |
|-------|------|-------|
| `version` | literal `1` | Same envelope literal as every API body |
| `type` | literal `"metrics"` | Closed union discriminator |
| `runId` | string | Opaque nonblank identifier, same convention as the runs REST contract |
| `seq` | integer | Nonnegative safe integer; monotonic per run — the schema enforces the range only, ordering is a documented producer obligation |
| `window.startMs` | integer | Nonnegative safe integer, run-relative milliseconds measured from run start (not epoch time) |
| `window.durationMs` | literal `1000` | Fixed 1000 ms (1 s) window |
| `reqPerSec` | number \| null | Finite requests per second ≥ 0 |
| `latencyMs.avg`, `latencyMs.p90`, `latencyMs.p95`, `latencyMs.p99` | number \| null | Finite milliseconds ≥ 0 |
| `httpFailureFraction` | number \| null | Finite fraction in `[0,1]` — never a percentage |
| `activeVUs` | integer | Nonnegative safe integer count, never null |
| `failedChecks` | integer | Nonnegative safe integer count, never null |

## Window, units and nullability

- Fixed 1000 ms windows; `startMs` is run-relative, so it resets with each run.
- Units: milliseconds for latency, fraction `[0,1]` for HTTP failures, finite ≥ 0 request
  rate, nonnegative safe-integer counts. No percentages, no microseconds, no counts-as-float.
- No-sample windows: when a window had no requests, `reqPerSec`, all four `latencyMs`
  percentiles and `httpFailureFraction` carry an explicit `null` — never a silent 0. The
  schema requires these sample-derived fields to be null exactly together, so a partially
  nulled frame rejects. `activeVUs` and `failedChecks` remain counts; `0` is meaningful.
- `seq` monotonicity and no-sample detection are producer obligations; the schema enforces
  ranges, units and nullability only.

## Boundary and separation

Declaration-only boundary: no message handlers, sockets, servers, aggregation, broadcast,
cross-frame sequence enforcement or reconnect/replay logic are introduced here. The windowed
topic is separate from the K6F1-04 cumulative final summary
(`GET /api/runs/{runId}/summary`), which stays cumulative and terminal-only — a metrics frame
never carries `thresholdsPassed` or cumulative totals.
