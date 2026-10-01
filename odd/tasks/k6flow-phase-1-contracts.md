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
- REST semantics, WS routing and metrics/recorder wire details require focused human decisions at their respective boundaries.
- Generated-only allowed install surfaces remain `node_modules/**`, `apps/web/node_modules/**`; add `packages/shared/node_modules/**` for the new workspace. Never commit generated outputs or `.codegraph/`.
- Human additionally authorized existing/future verification cache writes under `node_modules/.go-cache/**` and `node_modules/.go-mod-cache/**`; module downloads permitted. Never delete, stage or commit caches.

## Work units
- [ ] K6F1-01 — Shared contract foundation and test discovery. In progress. Register workspace, install pinned Zod, expose versioned runtime schema, discover shared tests and strict typechecking. Forecast 100–180 authored lines. Allowed source surfaces: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/version.ts`, `packages/shared/src/version.test.ts`, `pnpm-workspace.yaml`, `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`, `docs/DECISIONES.md`. Writer owns source only; parent owns this document.
- [ ] K6F1-02 — Graph structure/reference invariants. Pending foundation and agreement on any remaining semantics. Forecast 220–350 authored lines.
- [ ] K6F1-03 — Node parameters/global load configuration. Pending focused choices; four required node families. Forecast 250–380 authored lines.
- [ ] K6F1-04 — Runs/health OpenAPI and shared REST schemas with agreement checks. Pending REST choices. Forecast 300–400 authored lines.
- [ ] K6F1-05 — Versioned metrics WS contracts. Pending routing, units, aggregation and ordering decisions. Forecast 180–300 authored lines.
- [ ] K6F1-06 — Complete recorder REST/WS contracts, backend-neutral unless separately approved. Pending wire/lifecycle decisions. Forecast 250–400 authored lines.
- [ ] K6F1-07 — Human Phase 1 review before Phase 2.

## Verification and delivery
Foundation acceptance: shared tests are actually discovered, version schema rejects unsupported versions, strict shared TypeScript checking is included in root lint, existing tests/lint remain green. Run `pnpm test`, `pnpm lint`, `git diff --check` synchronously in writer; parent spot-check routed to verifier. Native assessment/review follows exact work-unit candidate boundaries; approval never authorizes publishing.

Runtime harness: N/A for foundation because it exposes validation only and does not add a process/network boundary. Rollback: revert only the shared foundation, workspace/test/typecheck integration and associated decision notes together; preserve Phase 0 services and human documents.

Forecast total 1,300–2,010 authored lines, excluding generated lockfile churn. Use coherent separate work-unit review slices with previously selected `stacked-to-main` strategy for future PRs; no PRs authorized now. Phase 0 size exception does not cover Phase 1. Do not minify, omit tests or split into broken intermediate states to meet budgets; revisit actual size before commits. Reviewed boundary for Phase 1: `1f72d82` (Phase 0 tracking candidate acknowledged separately under `review-07eacb3c12231232`).

## Progress and next action
Read-only map complete. User approved Zod, linear execution and explicit producer/output references. Writer `mupadlu5-c-2jzo` implemented foundation: observed unsupported-version assertion RED, then GREEN with 15 shared, 2 web and 6 deployment tests (23 total); install, lint and whitespace checks passed. Strict `{ version: 1 }` envelope rejects malformed/unsupported versions without coercion/defaults. Reported diff: 123 authored lines plus 15 lockfile additions; writer model `gpt-6.1-sol`, effort unavailable.

Writer returned partial because Go vet generated cache outside the install-only scope. Read-only scout `mupakluw-d-ki80` confirmed metadata shows no out-of-scope source changes or staging; existing `.go-cache` untracked, file count not independently verified. Human subsequently authorized both bounded verification cache paths. Native assessment unavailable due undeclared untracked files; high/unassessable plan requires independent verification. Verifier `mupaqb7m-e-c0j5` running `pnpm test`, cache-isolated `pnpm lint`, `git diff --check`. Task remains in progress until verifier, commit and candidate review complete. Ask remaining graph decisions before graph implementation.
