# K6Flow — Phase 1 Contracts

## Objective
Define validated shared graph, REST and versioned WebSocket contracts before runtime implementation. Stop for human Phase 1 review. Authority: `doc/ptomt_init/promot-init.md`, sections 5 and 12; human approved Phase 0 with `go`.

## Scope and constraints
- Branch: `feat/k6flow-phase-1-contracts`; local commits only, no push/PR/merge.
- Route: delegated direct, not SDD. Map: `mup9upsn-b-m06x`; multi-file writers delegated.
- Strict TDD: explicitly user-selected; runner `pnpm test`, observed behavioral RED then GREEN.
- Technical artifacts in English; direct user conversation in Spanish.
- Preserve initialization documents, UX assets, root `.gitignore`, generated outputs and human-owned `deploy/.env.example` (no direct access).
- No service handlers, translators, UI, recorder runtime, Docker Engine access, migrations or product authentication implementation.
- Zod explicitly approved, pinned at 4.6.5 with registry evidence in `docs/DECISIONES.md`. Existing TypeScript 5.9.3 and Vitest 4.0.18 remain.
- Graph execution explicitly approved: one linear sequence per virtual user, no branches/cycles; references identify producer node/output and only consume earlier results in the same traversal.
- Human approved separate draft and executable validation: empty/disconnected drafts can be retained; execution requires a complete linear chain and earlier-result references. K6F1-02 validates structure only; node parameters/load and supported output rules remain K6F1-03, so it must not claim full execution readiness.
- REST semantics, WS routing and metrics/recorder wire details require focused human decisions at their respective boundaries.
- Generated-only allowed install surfaces remain `node_modules/**`, `apps/web/node_modules/**`; add `packages/shared/node_modules/**` for the new workspace. Never commit generated outputs or `.codegraph/`.
- Human additionally authorized existing/future verification cache writes under `node_modules/.go-cache/**` and `node_modules/.go-mod-cache/**`; module downloads permitted. Never delete, stage or commit caches.

## Work units
- [x] K6F1-01 — Shared contract foundation and test discovery. Complete: independently verified, committed and native review acknowledged. Register workspace, install pinned Zod, expose versioned runtime schema, discover shared tests and strict typechecking. Forecast 100–180 authored lines. Allowed source surfaces: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/version.ts`, `packages/shared/src/version.test.ts`, `pnpm-workspace.yaml`, `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`, `docs/DECISIONES.md`. Writer owns source only; parent owns this document.
- [ ] K6F1-02 — Graph structure/reference invariants. In progress: draft/executable separation approved; delegate structure-only validation before parameter contracts. Forecast 220–350 authored lines.
- [ ] K6F1-03 — Node parameters/global load configuration. Pending focused choices; four required node families. Forecast 250–380 authored lines.
- [ ] K6F1-04 — Runs/health OpenAPI and shared REST schemas with agreement checks. Pending REST choices. Forecast 300–400 authored lines.
- [ ] K6F1-05 — Versioned metrics WS contracts. Pending routing, units, aggregation and ordering decisions. Forecast 180–300 authored lines.
- [ ] K6F1-06 — Complete recorder REST/WS contracts, backend-neutral unless separately approved. Pending wire/lifecycle decisions. Forecast 250–400 authored lines.
- [ ] K6F1-07 — Human Phase 1 review before Phase 2.

## Verification and delivery
Foundation acceptance: shared tests are actually discovered, version schema rejects unsupported versions, strict shared TypeScript checking is included in root lint, existing tests/lint remain green. Run `pnpm test`, `pnpm lint`, `git diff --check` synchronously in writer; parent spot-check routed to verifier. Native assessment/review follows exact work-unit candidate boundaries; approval never authorizes publishing.

Runtime harness: N/A for foundation because it exposes validation only and does not add a process/network boundary. Rollback: revert only the shared foundation, workspace/test/typecheck integration and associated decision notes together; preserve Phase 0 services and human documents.

Forecast total 1,300–2,010 authored lines, excluding generated lockfile churn. Use coherent separate work-unit review slices with previously selected `stacked-to-main` strategy for future PRs; no PRs authorized now. Phase 0 size exception does not cover Phase 1. Do not minify, omit tests or split into broken intermediate states to meet budgets; revisit actual size before commits. First slice: `1f72d82978f24d2560c0dad5e44d24704321148e` to `810873d38a33d33525809de48fd7770457bec12b`. Current reviewed boundary: `810873d38a33d33525809de48fd7770457bec12b`.

## Progress and next action
Read-only map complete. User approved Zod, linear execution and explicit producer/output references. Writer `mupadlu5-c-2jzo` implemented foundation: observed unsupported-version assertion RED, then GREEN with 15 shared, 2 web and 6 deployment tests (23 total); install, lint and whitespace checks passed. Strict `{ version: 1 }` envelope rejects malformed/unsupported versions without coercion/defaults. Reported diff: 123 authored lines plus 15 lockfile additions; writer model `gpt-6.1-sol`, effort unavailable.

Writer returned partial because Go vet generated cache outside the install-only scope. Read-only scout `mupakluw-d-ki80` confirmed metadata shows no out-of-scope source changes or staging; existing `.go-cache` untracked, file count not independently verified. Human subsequently authorized both bounded verification cache paths. Native assessment unavailable due undeclared untracked files; high/unassessable plan requires independent verification. Verifier `mupaqb7m-e-c0j5` passed `pnpm test` (23 tests), cache-isolated `pnpm lint`, `git diff --check`; no blocking findings or unexpected generated writes. Historical RED was writer-observed, not reproduced by verifier. Runtime N/A for validation-only foundation.

Commit `810873d38a33d33525809de48fd7770457bec12b`: 11 files, 173 additions/3 deletions including 38 task-document lines and 15 generated lockfile additions; 161 authored lines including bookkeeping. Human explicitly approved repository-local dependency exclusions `/node_modules/`, `/apps/web/node_modules/`, `/packages/shared/node_modules/` in `.git/info/exclude`; no tracked/global ignore changes. Inspection confirmed exact base/candidate trees `bc0ebaae8daf8ff34fdc08318d5939891a41f405` / `52f7f7401227e75b4a9fbeff2ce57de1a6fdc716` and 11 paths. Native review `review-0734a03fbfca52ba` (medium, 176 lines, one reliability reviewer) approved and acknowledged; authority burned. Target `sha256:977772b598d522520eccb97d1345abe7848f9c1b270aba309e384e1d8858fa7c`; consumed revision `sha256:e977f3a735ab623badbb7fbc1b921b2f734dee542198db6bc889b895ffbe95b3`. No corrections or advisory findings returned.

K6F1-02 writer `mupb5z0c-g-ckh4` completed graph structure, tests, exports, graph guide and decision notes; reported 315 authored additions. Behavioral disconnected-topology RED observed (1 failed/17 passed), then GREEN and triangulation: 63 tests (57 Vitest/6 deployment), including a 12,000-node chain. Lint initially failed on two type errors; corrected final lint and whitespace checks passed. Both draft and execution-topology schemas are structure-only; parameters/load/supported-output and extraction/binding semantics remain K6F1-03.

Native assessment again unavailable due undeclared new files; high/unassessable plan requires independent verification. Verifier `mupbcm1h-h-if5y` running full tests, cache-isolated lint and whitespace checks. K6F1-02 remains in progress until verification, budget reconciliation, commit and native candidate review against `810873d`.

Earlier tracking-only reminder target `sha256:e37fa54a5e6d61310d1953fb09eaffaf307a8b05579418bbe247926f442830be` was superseded during initial graph scaffolding; START stopped pre-authority at untracked selection. No lineage or capture was created for that partial candidate. The writer paused and explicitly resumed before observing RED. Post-review tracking edits are separate bookkeeping; no publishing authorized.
