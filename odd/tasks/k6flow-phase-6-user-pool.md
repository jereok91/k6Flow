# K6Flow — Phase 6 User Pool

## Objective and boundary
Implement user pool file management: CSV upload, storage, association with scenarios, and delivery to the orchestrator for K6 execution with `SharedArray`. Authority is `doc/ptomt_init/promot-init.md` §12 Phase 6 plus the frozen Phase 1 contracts (`csv-pool-parameters.ts`) and Phase 5 translator. Stop for human Phase 6 review before Phase 7 (init:176 pattern).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-6-user-pool` (new, stacked on Phase 5 final).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD: RED then GREEN. Runner `pnpm test` (859 baseline), `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).

## Stable work units
- [x] K6F6-01 — Attachments DB schema. COMPLETE (commit `50894b9`, bundled with K6F6-02).: `attachments` table (id, scenario_id, name, content_type, data, created_at). Migration.
- [x] K6F6-02 — Attachments API. COMPLETE (commit `cd0afe5`, 9 files, 787 lines). Native review `review-96390e9f2bc9132f` APPROVED.: POST /api/scenarios/:id/attachments (upload), GET (list), DELETE. File size limit ~1MB.
- [x] K6F6-03 — Editor file upload UI. COMPLETE (commit `f9ee7af`, bundled with K6F6-04).: drag-drop or file picker in UserPoolConfigPanel, show attached files, delete.
- [x] K6F6-04 — Run with attachments. COMPLETE (commit `c2d5556`, 3 files, 327 lines). Native review `review-de726c7b7594dd95` APPROVED.: include CSV files in orchestrator request, orchestrator writes to container.
- [ ] K6F6-05 — E2E proof: upload CSV, configure user-pool node, run scenario, verify K6 reads users.
- [ ] K6F6-06 — Human Phase 6 review gate.

## Acceptance, verification and review strategy
Each unit: RED/GREEN with `pnpm test`. Attachments: file uploads stored in DB, retrieved correctly. Integration: orchestrator receives files and K6 can read them. E2E: full flow with real CSV data.

Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Native assessment + independent verifier as needed. Track work-unit commits with Conventional Commits.

## Progress
Latest acknowledged work-unit boundary: (none yet). K6F6-01/02 commit `cd0afe5` (native-approved, ack burned). K6F6-03/04 commit `c2d5556` (native-approved, ack burned). Next: K6F6-05 E2E proof.
