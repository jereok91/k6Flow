# K6Flow — Phase 7 Recorder

## Objective and boundary
Implement the recorder service: HTTP proxy for traffic capture, REST/WS APIs per the Phase 1 contracts (`recorder-contracts.ts`), on-demand lifecycle, and guaranteed shutdown. Authority is `doc/ptomt_init/promot-init.md` §12 Phase 7 plus the frozen Phase 1 contracts and `docs/api/ws-recorder.md`. Stop for human Phase 7 review before Phase 8 (init:176 pattern).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-7-recorder` (new, stacked on Phase 6 final).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD: RED then GREEN. Runner `pnpm test` (872 baseline), `go test ./...`, `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).

## Stable work units
- [x] K6F7-01 — Recorder Go module scaffold: `apps/recorder/` with main, config, Dockerfile. Health endpoint. (commit `d966be0`, 240 lines, 4 Go tests)
- [x] K6F7-02 — Recording store: in-memory store for recording sessions (id, status, captures). CRUD operations. (commit `0c4dcc9`, 381 lines, 14 Go tests)
- [x] K6F7-03 — HTTP proxy core: forward proxy that captures requests/responses. (commit `a27f617`, 395 lines, 8 Go tests)
- [x] K6F7-04 — REST API: POST /recordings (create), GET /recordings/{id} (state), POST /recordings/{id}/stop (idempotent stop with captures). (commit `bf5170b`, 445 lines, 11 Go tests)
- [x] K6F7-05 — WebSocket streaming: /ws/recordings/{id} for real-time capture events. (commit `1b4bc40`, 477 lines, 8 Go tests)
- [x] K6F7-06 — Lifecycle management: cleanup triggers (inactivity, max-duration), guaranteed shutdown. (commit `92be209`, 388 lines, 7 Go tests)
- [x] K6F7-07 — Docker integration: docker-compose service, network isolation. (commit `1a28f81`, 117 lines)
- [x] K6F7-08 — Frontend integration: recorder UI in web app (start/stop/view captures). (commit `b282d8b`, 360 lines)
- [x] K6F7-09 — E2E proof: contract tests in shared + phase-0 updated for recorder service. (commit `d43d9fa`)
- [x] K6F7-10 — Human Phase 7 review gate. APPROVED (user verified RECORDING state works). Phase 8 authorized.

## Acceptance, verification and review strategy
Each unit: RED/GREEN with tests. Recorder: Go unit tests for store/proxy/handlers. Integration: REST API returns valid contract responses. E2E: full flow with real HTTP traffic capture.

Commands: `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Native assessment + independent verifier as needed. Track work-unit commits with Conventional Commits.

## Progress
Phase 7 implementation complete. 9/10 tasks done. Awaiting human review gate (K6F7-10).

**Summary:**
- 10 commits, ~2,800 authored lines
- 52 Go tests across 5 packages
- Recorder service: REST API + WebSocket + HTTP proxy + lifecycle management
- Frontend: /recorder page with real-time capture display
- Docker: recorder service added to docker-compose.yml

**Go test count:** `go test ./...` passes all packages (config, httpapi, lifecycle, proxy, store, wsapi)
**Vitest baseline:** 872 tests (29 suites)
