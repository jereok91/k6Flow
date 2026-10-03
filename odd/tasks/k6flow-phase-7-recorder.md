# K6Flow — Phase 7 Recorder

## Objective and boundary
Implement the recorder service: HTTP proxy for traffic capture, REST/WS APIs per the Phase 1 contracts (`recorder-contracts.ts`), on-demand lifecycle, and guaranteed shutdown. Authority is `doc/ptomt_init/promot-init.md` §12 Phase 7 plus the frozen Phase 1 contracts and `docs/api/ws-recorder.md`. Stop for human Phase 7 review before Phase 8 (init:176 pattern).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-7-recorder` (new, stacked on Phase 6 final).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD: RED then GREEN. Runner `pnpm test` (872 baseline), `go test ./...`, `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).

## Stable work units
- [ ] K6F7-01 — Recorder Go module scaffold: `apps/recorder/` with main, config, Dockerfile. Health endpoint.
- [ ] K6F7-02 — Recording store: in-memory store for recording sessions (id, status, captures). CRUD operations.
- [ ] K6F7-03 — HTTP proxy core: mitmproxy-style transparent proxy that captures requests/responses.
- [ ] K6F7-04 — REST API: POST /recordings (create), GET /recordings/{id} (state), POST /recordings/{id}/stop (idempotent stop with captures).
- [ ] K6F7-05 — WebSocket streaming: /ws/recordings/{id} for real-time capture events.
- [ ] K6F7-06 — Lifecycle management: cleanup triggers (inactivity, max-duration), guaranteed shutdown.
- [ ] K6F7-07 — Docker integration: docker-compose service, network isolation.
- [ ] K6F7-08 — Frontend integration: recorder UI in web app (start/stop/view captures).
- [ ] K6F7-09 — E2E proof: start recording → proxy traffic → stop → see captures.
- [ ] K6F7-10 — Human Phase 7 review gate.

## Acceptance, verification and review strategy
Each unit: RED/GREEN with tests. Recorder: Go unit tests for store/proxy/handlers. Integration: REST API returns valid contract responses. E2E: full flow with real HTTP traffic capture.

Commands: `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Native assessment + independent verifier as needed. Track work-unit commits with Conventional Commits.

## Progress
Latest acknowledged work-unit boundary: (none yet). Next: K6F7-01 recorder scaffold.
