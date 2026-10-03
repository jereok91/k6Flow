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
