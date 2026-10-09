# k6flow — Run follow-ups (proxies, history metrics, completion summary)

## Problems
1. `/api/orchestrator/runs/active`, `/preflight`, `/emergency-stop` proxies use `ORCHESTRATOR_URL` (default `localhost:8080`, unreachable inside the web container) and `ORCHESTRATOR_TOKEN` (unset) instead of `ORCHESTRATOR_INTERNAL_URL` / `ORCHESTRATOR_SERVICE_TOKEN`; no `requireUser`. Sidebar polls `/active`, flooding failed requests.
2. `updateRunStatus` stores `round(fraction*100)` while the schema documents basis points (5.5% = 550); `avgDurationMs` of 0 is dropped (truthiness check). No rows were persisted with the bad scale (PATCH always failed before 4780f12), so no data migration is needed.
3. RunExecutionPanel polling and "already finished" completion paths do not fetch the run summary, so iterations persist as 0.

4. Endpoints/Errores tabs show empty method/URL: Go `EndpointMetrics`/`FailureGroup` nest method/url under `key`, page expects flat fields. Failures use a different key (no `name`) than requests, so one endpoint splits into two rows and Error % is 0. k6 `error`/`error_code` tags are not captured.
5. Executions page fetches `/summary` while the run is live (409 until terminal).
6. Sidebar polls `/api/orchestrator/runs/active`; user decision: replace with a global runs WebSocket (`/ws/runs`) pushing run lifecycle events.

7. Security: `RunExecutionPanel.tsx` ships `ORCHESTRATOR_SERVICE_TOKEN` default ("k6flow-internal-token") in the client bundle and connects straight to `127.0.0.1:8080` in dev; prod path sends no token (auth fails).
8. Executions page opens `/api/orchestrator/ws/metrics/{id}` (nonexistent); the rewrite is `/api/ws/:path*` -> orchestrator `/ws/:path*`.

## Tasks
- [x] T1 Fix orchestrator proxies (active, preflight, emergency-stop): shared config, auth, status passthrough — `59b7e62` (emergency-stop admin-only)
- [x] T2 History metrics: errorRate basis points round-trip (tested), keep avgDurationMs 0 — `59cb567`
- [x] T3 Completion summary on polling / already-finished paths — `d6afc99`
- [x] T4 Orchestrator endpoints/failures contract: flat fields, unified key, error tags, error rate (Go tests) — `0d0174d`
- [x] T5 Executions page: fetch summary only when terminal; refresh endpoints/failures while live — `75c96e9`
- [x] T6a Browser WebSocket auth via short-lived signed tickets (web mints after requireUser + ownership; orchestrator verifies); remove hardcoded service token from RunExecutionPanel; fix executions page WS URL (/api/ws/runs/{id}) — `0394bac`
- [x] T6b Global runs WebSocket (lifecycle events) in orchestrator; Sidebar subscribes instead of polling /active — `ab93ec2`

## Evidence
- T6a: ticket tests Go+web (cross-language vector; RED compile/behavior -> GREEN); go test ./... ok; apps/web 23 files / 288 tests; tsc clean; no service token in client code
- T4/T5 review review-cb0db9a57b9edef1 approved + acknowledged (advisory endpoints.go:72, :166)
- T4/T5: metrics tests (RED build failure -> GREEN 9 tests); go test ./... ok, vet clean; apps/web 278 tests; tsc clean
- T1-T3 review review-165621585e8f79ff approved + acknowledged (advisory proxy.ts:9)
- T1-T3: proxy 5 + metrics 12 tests (RED missing module -> GREEN); apps/web 22 files / 278 tests; tsc clean

## Follow-ups
- Recorder still passes its token in the WS URL (?token=) — same class of leak
- docs/DECISIONES.md K6F3-02 still describes subprotocol-only auth
- lib/live-metrics.ts wsProtocols now unused by browser code

## Review state (T6a) — resolved
- Lineage review-89f8bec695818126 (high tier, 4 lenses + refuter) -> correction_required: candidate-caused severe finding confirmed by refuter.
- Blocked: correction must be applied on a quiet worktree; T6b worker (mv0jlmyk-9-rimr) is concurrently editing live/server.go and web ws-ticket files, so the intended-untracked selection binding was rejected.
- Plan: let T6b finish, stash T6b changes (git stash -u), re-query bound STATUS, apply the bounded correction to T6a, commit, finish review, then restore T6b and rebase it on the corrected code.
- Correction applied: `26535b2` removes the publicly known fallback ticket secret (finding R1-known-ticket-secret, CRITICAL, refuter-confirmed). RED: expected 'k6flow-internal-token' to be '' -> GREEN 11/11; apps/web 289 tests.
- After the correction commit, STATUS returned terminal stop `captured_artifacts_unverifiable` (likely due to the concurrent T6b worktree churn during collection). Lineage review-89f8bec695818126 needs maintainer inspection or a fresh review START over 29c4545..HEAD.
- T6b: `ab93ec2`; go test ./... ok, vet clean; apps/web 24 files / 309 tests; tsc clean. main_test.go routing row updated (bare /ws/runs now 401).
- Remaining gap: a pending run stopped via httpapi before Launch only emits runs.end once Launch sees it.
