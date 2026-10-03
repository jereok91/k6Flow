# K6Flow — Phase 8 Capture to Graph

## Objective and boundary
Implement the capture-to-graph translator: convert recorded HTTP traffic into graph nodes for the visual editor. Authority is `doc/ptomt_init/promot-init.md` §12 Phase 8 plus the frozen Phase 1 contracts. Stop for human Phase 8 review before Phase 9 (init:176 pattern).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-8-capture-to-graph` (new, stacked on Phase 7 final).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD: RED then GREEN. Runner `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).

## Stable work units
- [x] K6F8-01 — Capture-to-node mapper: TypeScript function to convert `RecorderCaptureEntry[]` to graph nodes. (commit `62cbd3a`, 468 lines, 16 tests)
- [x] K6F8-02 — Auth detection heuristics: identify login/auth requests and suggest auth node placement.
- [x] K6F8-03 — Dynamic value detection: identify tokens, session IDs, CSRF tokens for parameterization.
- [x] K6F8-04 — Import UI: recorder → editor flow (import captures as draft scenario).
- [x] K6F8-05 — Edit after import: allow editing imported nodes before save.
- [ ] K6F8-06 — E2E proof: record traffic → import → see graph → edit → save.
- [ ] K6F8-07 — Human Phase 8 review gate.

## Acceptance, verification and review strategy
Each unit: RED/GREEN with tests. Mapper: pure TypeScript with unit tests. Integration: full flow from recorder captures to editable graph.

Commands: `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Native assessment + independent verifier as needed. Track work-unit commits with Conventional Commits.

## Progress
Latest acknowledged work-unit boundary: (none yet). Next: K6F8-01 capture-to-node mapper.
