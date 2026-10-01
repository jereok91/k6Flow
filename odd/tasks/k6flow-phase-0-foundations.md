# K6Flow — Phase 0 Foundations

## Objective
Build only the Phase 0 foundations for the K6Flow monorepo. Preserve the initialization documents and defer every later phase until the user reviews this phase.

## Problem and rationale
The repository currently contains the product brief and visual references but no application scaffold, service code, database wiring, CI, or architecture decision log. Establish a runnable and testable base without inventing unresolved product choices or pretending later functionality exists.

## Scope
- Monorepo structure for Next.js/React/TypeScript web and Go orchestrator; recorder remains on-demand and is not a permanent Compose service.
- pnpm workspace (recommended explicitly by the brief) and baseline lint/test/build checks.
- Minimal web and orchestrator services with health checks; PostgreSQL is the selected database.
- Minimal Compose/development Compose wiring, health checks, and secret-free `.env.example`.
- Basic CI and architecture/decision documentation.
- UX/UI is an end-to-end constraint for later UI phases: follow `doc/UX_UI/` references, including the dark, dense engineering visual language. Phase 0 does not implement the dashboard/editor/run/recording product views.

## Out of scope
- Graph contracts, API/OpenAPI, authentication, history/retention policy, K6 execution, metrics dashboard, editor, recorder, reverse proxy/HTTPS deployment, and Docker Engine access.
- Changes to the user-provided `doc/ptomt_init/promot-init.md`, `doc/ptomt_init/infoProyect.md`, `.gitignore`, or UX reference assets.
- Push, pull request, or merge.

## Constraints and resolved choices
- Architecture authority: `doc/ptomt_init/infoProyect.md` and `doc/ptomt_init/promot-init.md`; the latter's final note explicitly selects PostgreSQL.
- Technologies: Next.js, React, TypeScript, Go, PostgreSQL, Docker Compose, and pnpm workspaces as recommended by the brief. Do not add product frameworks beyond what Phase 0 needs.
- Strict TDD: **enabled by explicit user choice in this session**. Source: direct user selection. Exact test runners: `pnpm test` and `go test ./...`; record observed RED before implementation and GREEN afterward for behavior-bearing changes.
- Work branch: `feat/k6flow-phase-0-foundations` (created before project writes).
- Local work-unit commits: explicitly authorized; no push/PR/merge authorization.
- Generated-output scope: the user explicitly approved tool-generated `node_modules/**`, `apps/web/node_modules/**`, `apps/web/.next/**`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`, and `apps/orchestrator/server`. These outputs must remain excluded from commits. This does not expand manually authored edit surfaces.
- Existing worktree state to preserve: modified `doc/ptomt_init/promot-init.md`; untracked `.gitignore`, `doc/ptomt_init/infoProyect.md`, and generated `.codegraph/` index.
- No unresolved choice blocks Phase 0. Ask before implementing the deferred choices in their relevant phase: authentication/roles, retention, WebSocket routing, Playwright vs Puppeteer, Docker socket mitigation, and reverse proxy.

## Task checklist

### K6F0-01 — Establish the web and Go workspace skeleton
- [x] Create the root JS workspace and minimal Next.js web app.
- [x] Create the Go orchestrator skeleton and tested `/healthz` behavior.
- [x] Add behavior-level tests before implementation and capture RED/GREEN evidence under strict TDD.
- [x] Keep the web service intentionally minimal; do not fabricate operational metrics or unfinished product interactions.
- **Acceptance:** `pnpm test` and `go test ./...` pass; both service skeletons are independently buildable; no later-phase behavior is implied.
- **TDD evidence:** RED — JS returned 501 instead of 200 and omitted JSON; Go returned 404 instead of readiness 200 and method-rejection 405. GREEN — two JS tests and all Go tests/subtests passed. Triangulation covers repeated probes, unknown routes, health subpaths, and unsupported methods.
- **Verification:** `pnpm install` passed (esbuild/sharp build-script warnings); `pnpm test` passed (2 tests); `pnpm --filter @k6flow/web build` passed; `cd apps/orchestrator && go test ./...` passed; `cd apps/orchestrator && go build ./...` passed.
- **Runtime harness:** N/A for this source-only skeleton before Compose exists; handler behavior is tested directly, and container/runtime health integration is K6F0-02.
- **Generated artifact disposition:** `apps/orchestrator/server` was created by `go build`; user approved retaining it uncommitted. Dependency/build outputs likewise remain uncommitted.
- **Rollback boundary:** remove the K6F0-01 web/Go workspace files and root workspace manifests/lockfile; do not touch initialization docs or existing user files.
- **Route:** delegated direct writer (multi-file source change); parent owns task document and commits.
- **Verification evidence:** all listed TDD, tests, and builds passed; parent review/spot-check and native assessment pending.
- **Commit:** pending.

### K6F0-02 — Wire Compose, CI, and Phase 0 documentation
- [ ] Add web, orchestrator, and PostgreSQL Compose services with health checks; keep the orchestrator internal-only and K6/recorder out of permanent services.
- [ ] Add development Compose, Dockerfiles as needed, and a secret-free `.env.example`.
- [ ] Add baseline CI and architecture/decision documentation without altering initialization/reference assets.
- [ ] Validate the documented local startup path and health checks.
- **Acceptance:** documented Compose startup brings up healthy web/orchestrator/PostgreSQL; orchestrator has no published host port; no K6/recorder permanent services; CI commands and tests pass; `.env.example` has no real secret values.
- **Route:** delegated direct writer (multi-file source change); parent owns task document and commits.
- **Verification evidence:** pending.
- **Commit:** pending.

## Delivery and review workload
- Strategy: `ask-on-risk` (ODD default); assess the prospective work-unit commit under native RDD before delivery reporting.
- Forecast: approximately 250–400 authored changed lines across Phase 0, excluding generated files; refine before each commit. If the forecast exceeds about 400, pause and resolve the chain strategy before committing.
- Phase gate: stop after Phase 0 and request user review before any Phase 1 contract work.

## Progress
- Exploration completed: no application scaffold exists; UX references and architecture/phase constraints are mapped.
- Current status: K6F0-01 code, strict-TDD checks, and builds completed; parent staged only the 14 authored manifests/source/test files, excluding generated outputs. The generated executable `apps/orchestrator/server` is approved to remain uncommitted.
- Next step: stage this evidence record, commit the work unit, run native risk assessment and the required parent spot-check, then proceed to K6F0-02.
