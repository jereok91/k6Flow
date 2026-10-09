# Runs REST contract (version 1)

`packages/shared/src/runs-rest.ts` declares this contract with strict Zod schemas, inferred
types and one pure idempotency derivation — no handlers, servers, stores, schedulers, option
parsing or threshold evaluation. [openapi.yaml](openapi.yaml) mirrors it for tooling.

| Method | Path | Success | Declared errors |
|--------|------|---------|-----------------|
| POST | `/api/runs` | `202` new run, `200` idempotent replay | `400`, `401`, `422` |
| POST | `/api/runs/preflight` | `200` validation result | `400`, `401`, `422` |
| GET | `/api/runs/{runId}` | `200` run state | `401`, `404` |
| POST | `/api/runs/{runId}/stop` | `202` stop accepted | `401`, `404` |
| GET | `/api/runs/{runId}/summary` | `200` cumulative summary | `401`, `404`, `409` |
| GET | `/healthz` | `200` `{"status":"ok"}`, public and unversioned | none |

## Approved policies

1. **Lifecycle** — `POST /api/runs` answers `202` with `runId`; an identical `Idempotency-Key`
   and payload replays `200` with the existing runId (pure derivation, no store), an absent key
   always creates; stop `202`, unknown runId `404` (stop/summary), nonterminal summary `409`.
2. **Statuses** — closed set `pending|running|finished|failed|stopped`; `finished` means normal completion including threshold evaluation (only that summary carries `thresholdsPassed`); `failed` is reserved for engine/infra errors.
3. **Run start config** — an already compiled opaque script string, never a graph or parsed
   options; REST `vus`/`durationMs` always override script-embedded options; `cpuMillis` and
   `memoryMiB` are required positive safe integers; attachments are opaque ids, no byte upload.
4. **Auth and versioning** — static `Authorization: Bearer <token>` on all `/api/*` (`401` when
   missing/invalid); every API body carries the literal `version: 1`; the unversioned
   `/healthz` stays public and process-only, untouched by this unit.

## Summary, errors and boundary

The final summary is cumulative — `totals` (`requests`, `errors`, `failedChecks`), `latency`
(`avgMs`, `p90Ms`, `p95Ms`, `p99Ms`) and `thresholdsPassed` for `finished` — explicitly
separate from the windowed WebSocket topic (K6F1-05). Error bodies are `{ version, code,
message }` with catalog `unauthorized` → 401, `run-not-found` → 404, `summary-not-terminal`
→ 409, mirrored by `runErrorCatalogSchema` and OpenAPI. Boundary: declarations only.

## Per-run resource limits

`POST /api/runs` and `POST /api/runs/preflight` check per-run ceilings after body validation
(a malformed body stays `400 invalid-request`). Limits are inclusive; an over-limit start
creates no run, launches no container and does not consume its `Idempotency-Key`.

| Code | Status | Trigger | Orchestrator variable (default) |
|------|--------|---------|---------------------------------|
| `vus-limit-exceeded` | `422` | `vus` above the limit | `MAX_VUS_PER_RUN` (500) |
| `memory-limit-exceeded` | `422` | `memoryMiB` above the limit | `MAX_MEMORY_MIB_PER_RUN` (4096) |
| `cpu-limit-exceeded` | `422` | `cpuMillis` above the limit | `MAX_CPU_MILLIS_PER_RUN` (4000) |

The `message` names the requested value, the limit and the variable, e.g.
`requested 1900 VUs exceeds the per-run limit of 500 (MAX_VUS_PER_RUN)`. When several
ceilings are exceeded, only the first in the order VUs → memory → CPU is reported.
