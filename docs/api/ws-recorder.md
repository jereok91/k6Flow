# Recorder REST/WS contract (version 1)

`packages/shared/src/recorder-contracts.ts` declares the recorder REST and WebSocket
contracts with strict Zod schemas and inferred types. This unit is declaration-only:
no handlers, sockets, containers, byte transport, redaction implementation, secret
visibility/retention config, filter logic or recording runtime. The REST side for runs
is [runs.md](runs.md); the metrics WS topic is [ws-metrics.md](ws-metrics.md).

## REST endpoints

| Method | Path | Success | Declared errors |
|--------|------|---------|-----------------|
| POST | `/api/recorder/recordings` | `201` created with `recordingId` | `401` |
| GET | `/api/recorder/recordings/{recordingId}` | `200` recording state | `401`, `404` |
| POST | `/api/recorder/recordings/{recordingId}/stop` | `200` idempotent stop with capture | `401`, `404` |

Unknown `recordingId` → `404`. Error bodies are `{ version, code, message }` with catalog
`unauthorized` → 401, `recording-not-found` → 404.

## WebSocket topic

| Item | Contract |
|------|----------|
| Topic | `/ws/recordings/{recordingId}` — one recording-scoped bidirectional stream |
| Auth | `Authorization: Bearer <token>` on the WS handshake; `401` uniform with REST |
| Input frame | `init` — declared but not implemented |

Routing is documentation only: no proxy, upgrade or socket code ships in this unit.

## Lifecycle states

Explicit closed set: `pending|recording|stopping|completed|failed`. Terminal states are
`completed` and `failed`. These are declarations only — no state machine implementation.

## Cleanup triggers

Explicit closed set: `run-finished|closed|inactivity|max-duration|manual`. Expiration
via the declared cleanup triggers is a runtime obligation, not enforced by the schema.

## Idempotent stop

Repeated stop is idempotent: the same terminal state is returned with no extra effect.
Capture is delivered exactly once — a runtime obligation. There is no structured error
for repeated stop because it is idempotent, not an error.

## Capture format

Raw HTTP transcript entries: `{method, url, status, headers, bodyExcerpt?, redacted}`.
This is explicitly **NOT** the graph HTTP-node literal/reference AST. `method`, `url`,
`status` and `headers` are required; `bodyExcerpt` is an optional string; `redacted` is
a boolean. Import→graph mapping is deferred to a later phase.

## Auth and versioning

Static `Authorization: Bearer <token>` on all `/api/recorder/*` routes and on the
recording WS handshake `/ws/recordings/{recordingId}` (`401` uniform). Every API body
carries the literal `version: 1`, consistent with the runs and metrics contracts.

## Declaration-only boundary

No handlers, sockets, containers, Docker, byte transport, redaction implementation,
secret visibility/retention config, filter logic or recording runtime. Import→graph
mapping is deferred. Runtime harness: N/A; pure declarations add no process/network
boundary.
