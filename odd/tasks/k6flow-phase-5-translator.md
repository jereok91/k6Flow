# K6Flow — Phase 5 Graph-to-K6 Translator

## Objective and boundary
Build the graph-to-K6 translator: convert `GraphDraftComposition` to executable K6 scripts, wire the editor to the orchestrator, and complete the flow: draw → generate → execute → see metrics. Authority is `doc/ptomt_init/promot-init.md` §12 Phase 5 plus the frozen Phase 1 contracts in `packages/shared` and the Phase 2/3 orchestrator API. Stop for human Phase 5 review before Phase 6 (init:176 pattern).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-5-translator` (new, stacked on Phase 4 final `7ffccaf`).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD: RED then GREEN. Runner `pnpm test` (851 baseline: 845 vitest + 6 node), `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).
- Init §13 requirement: "El mismo grafo siempre genera el mismo script K6" — deterministic generation mandatory.

## Stable work units
- [x] K6F5-01 — Graph-to-K6 translator core. COMPLETE (commit `4fc015b`, 3 files, 618 lines). Native review `review-8e87a6fe85dba943` APPROVED.: pure function in `packages/shared` that converts `GraphDraftComposition` to a valid K6 script string. Deterministic output. Unit tests covering all 4 node types.
- [ ] K6F5-02 — Orchestrator integration: API endpoint to accept graph, translate, and queue execution. May require new endpoint or extend existing `/runs` POST.
- [ ] K6F5-03 — Editor → Run wiring: "Run" button in editor that sends graph to orchestrator and navigates to live metrics dashboard.
- [ ] K6F5-04 — End-to-end proof: draw scenario in editor → generate K6 → execute against mock target → see metrics. Docker-based test.
- [ ] K6F5-05 — Human Phase 5 review gate.

## Acceptance, verification and review strategy
Each unit: RED/GREEN with `pnpm test`. Translator: deterministic output proven by snapshot tests (same graph → same script). Integration: orchestrator accepts graph and returns run ID. E2E: editor triggers run and metrics appear in dashboard.

Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Native assessment + independent verifier as needed. Track work-unit commits with Conventional Commits.

## Progress
Latest acknowledged work-unit boundary: (none yet). Next: K6F5-02 orchestrator integration.

Latest acknowledged work-unit boundary: K6F5-01 commit `4fc015b` (native-approved, review `review-8e87a6fe85dba943`, ack burned). Next: K6F5-02 orchestrator integration.
