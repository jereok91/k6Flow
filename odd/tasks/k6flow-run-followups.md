# k6flow — Run follow-ups (proxies, history metrics, completion summary)

## Problems
1. `/api/orchestrator/runs/active`, `/preflight`, `/emergency-stop` proxies use `ORCHESTRATOR_URL` (default `localhost:8080`, unreachable inside the web container) and `ORCHESTRATOR_TOKEN` (unset) instead of `ORCHESTRATOR_INTERNAL_URL` / `ORCHESTRATOR_SERVICE_TOKEN`; no `requireUser`. Sidebar polls `/active`, flooding failed requests.
2. `updateRunStatus` stores `round(fraction*100)` while the schema documents basis points (5.5% = 550); `avgDurationMs` of 0 is dropped (truthiness check). No rows were persisted with the bad scale (PATCH always failed before 4780f12), so no data migration is needed.
3. RunExecutionPanel polling and "already finished" completion paths do not fetch the run summary, so iterations persist as 0.

4. Endpoints/Errores tabs show empty method/URL: Go `EndpointMetrics`/`FailureGroup` nest method/url under `key`, page expects flat fields. Failures use a different key (no `name`) than requests, so one endpoint splits into two rows and Error % is 0. k6 `error`/`error_code` tags are not captured.
5. Executions page fetches `/summary` while the run is live (409 until terminal).
6. Sidebar polls `/api/orchestrator/runs/active`; user decision: replace with a global runs WebSocket (`/ws/runs`) pushing run lifecycle events.

## Tasks
- [x] T1 Fix orchestrator proxies (active, preflight, emergency-stop): shared config, auth, status passthrough — `59b7e62` (emergency-stop admin-only)
- [x] T2 History metrics: errorRate basis points round-trip (tested), keep avgDurationMs 0 — `59cb567`
- [x] T3 Completion summary on polling / already-finished paths — `d6afc99`
- [ ] T4 Orchestrator endpoints/failures contract: flat fields, unified key, error tags, error rate (Go tests)
- [ ] T5 Executions page: fetch summary only when terminal; refresh endpoints/failures while live
- [ ] T6 Global runs WebSocket (/ws/runs) in orchestrator + web proxy; Sidebar subscribes instead of polling

## Evidence
- T1-T3: proxy 5 + metrics 12 tests (RED missing module -> GREEN); apps/web 22 files / 278 tests; tsc clean
