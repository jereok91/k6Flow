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
| GET | `/api/runs/{runId}/endpoints` | `200` per-endpoint metrics | `401`, `404` |
| GET | `/api/runs/{runId}/failures` | `200` failure groups | `401`, `404` |
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

## Endpoints and failures

Both are cumulative, available while the run is live and after it ends, and built from the
k6 JSON point tags `method`, `url`, `name`, `status`, `error` and `error_code`.

```json
{ "version": 1, "endpoints": [
  { "method": "GET", "url": "https://api.test/items/1", "name": "https://api.test/items/${id}",
    "requests": 4, "failures": 1, "errorRate": 0.25,
    "avgDurationMs": 25, "minDurationMs": 20, "maxDurationMs": 40, "p95DurationMs": 40 } ] }
```

- **Grouping** — one row per `method` + `name`, falling back to `url` when `name` is empty
  (k6's `name` tag defaults to the URL and groups dynamic URLs). `url` is the first URL seen.
- **Counts** — `requests` counts every request, failed or not (one `http_req_duration` point
  each); `failures` counts `http_req_failed` points with value 1, on the same row.
- **`errorRate`** — `failures / requests` as a 0–1 fraction, `0` when `requests` is 0.
- **Order** — `requests` descending.

```json
{ "version": 1, "failures": [
  { "method": "GET", "url": "https://api.test/items/2", "status": 0, "errorCode": "1211",
    "count": 1, "lastError": "dial tcp: i/o timeout", "lastSeenMs": 1772366400200 } ] }
```

- **Grouping** — endpoint (as above) + `status` + `errorCode`; `url` is the first URL seen.
- **`status`** — HTTP status; `0` means a network error (no response).
- **`errorCode` / `lastError`** — the k6 `error_code` and latest `error` tags (`""` when absent).
- **`lastSeenMs`** — point time of the latest failure, ms since epoch.
- **Order** — `count` descending.

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

## Secret variable env

`POST /api/runs` (and `/api/runs/preflight`) accept an optional `env` object that becomes
container environment for k6. It carries secret variables (`{{token}}` in the editor), which
the translator writes into the script as `__ENV["K6FLOW_VAR_TOKEN"]` instead of a literal.

```json
{ "version": 1, "script": "...", "vus": 1, "durationMs": 30000, "cpuMillis": 750,
  "memoryMiB": 256, "env": { "K6FLOW_VAR_TOKEN": "<secret>" } }
```

| Rule | Limit |
|------|-------|
| Key | `^K6FLOW_VAR_[A-Z0-9_]{1,80}$` |
| Entries | at most 100 |
| Value | string, at most 8 KiB (UTF-8 bytes) |
| Total | keys + values at most 64 KiB |

A violation is `400 invalid-request`; no run is created. The key namespace is disjoint from
the runtime's reserved script key (`K6FLOW_SCRIPT`) and from any other container env, so a
request can never override them. The engine also drops any key outside `K6FLOW_VAR_`.

Values are request-scoped. They reach the container spec in memory and are **never** stored
in the run record, returned by any `GET`, echoed in errors or written to logs. The
idempotency payload hash covers the raw body, `env` included: a replay with a different
secret is a different payload (new run), and only the SHA-256 digest is kept.

Browsers never send `env`. They send `environmentId` and `requiredEnv` (env names only) to
the web proxy `POST /api/orchestrator/runs`, which resolves the values server-side:

| Proxy answer | When |
|--------------|------|
| `400 { error }` | malformed `scenarioId`, `environmentId` or `requiredEnv` |
| `403` / `404` | scenario not owned (owner or admin) / environment not owned, or unknown |
| `422 { error, errors }` | a required name has no secret value, secret names collide, or secrets are requested with no scenario or environment |

The proxy discards any client-sent `env`, strips its own fields, and forwards only
`env` entries for requested names that map to secret variables. Shared schema:
`runEnvSchema` in `packages/shared/src/runs-rest.ts`.
