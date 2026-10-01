# K6Flow — Phase 0 Foundations

## Objective and scope
Establish a runnable Next.js/Go/pnpm/PostgreSQL base with Compose, CI and operating documentation. Stop for human Phase 0 review before contracts or product implementation. Authority: `doc/ptomt_init/infoProyect.md`, `doc/ptomt_init/promot-init.md`; later UI follows `doc/UX_UI/`.

## Constraints
- Preserve user initialization documents, UX assets, `.gitignore` including `.atl/`, and generated outputs.
- Branch `feat/k6flow-phase-0-foundations`; local commits authorized, no push/PR/merge.
- Strict TDD explicitly selected by user; runners `pnpm test`, `go test ./...`. Observe RED then GREEN for new behavior.
- Generated-only approved surfaces: `node_modules/**`, `apps/web/node_modules/**`, `apps/web/.next/**`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`, `apps/orchestrator/server`; exclude from commits along with `.codegraph/`.
- Human owns `deploy/.env.example`: agent reads/writes denied by policy; human created it. Only existence check and authorized Compose consumption occurred. Do not bypass policy to inspect/stage it.
- Defer auth, contracts, retention, WebSocket routing, recorder choice, Docker Engine access, proxy and product views. Permanent services only web, internal Go and PostgreSQL.

## Tasks
### K6F0-01 — Workspace and service skeletons
- [x] Create minimal web/Go services and workspace, tested health handlers and unchanged root ignore file.
- **Commits:** `0b27fe7`, `1746e08`.
- **TDD:** web RED 501/missing JSON, Go RED 404 versus 200/405; GREEN web tests and Go subtests, including repeat probes and invalid paths/methods.
- **Checks:** writer install/test/web build/Go test/build passed; install script warnings for esbuild/sharp. Independent web/Go tests passed and matched handlers.
- **Runtime:** N/A before Compose; direct handler tests; container acceptance delegated to K6F0-02.
- **Review:** approved and acknowledged, authority burned under `review-d12c0c5df9607853`; human authorized docs added in `3668187` within complete review range.
- **Reviewed base for next unit:** `36681874636e1d2c5c0c613d53c939d02d257c20`.
- **Historical review failures:** created no authority; correctly scoped committed-range inspect preceded success. Underlying projection-drift cause unproven.
- **Route/rollback:** delegated multi-file writer; remove only skeleton/workspace behavior, preserve user docs and generated outputs.

### K6F0-02 — Deployment, CI and documentation
- [x] Implement production/dev Compose, Dockerfiles, process health checks and internal-only Go/DB.
- [x] Implement CI and English startup/architecture/decision docs.
- [x] Observe deployment TDD and independently verify local runtime acceptance.
- [x] Complete final spot check: eight tests passed with zero skips/failures.
- [ ] Complete local work-unit commit and native candidate review.
- **Status:** in progress; local verification complete, commit/native review pending.
- **Route:** single delegated writer (multi-file trigger), independent verifier after native assessment unavailable/high; parent owns tracking, commits and native lifecycle.
- **Source surfaces:** `.dockerignore`, `.github/workflows/ci.yml`, `README.md`, `apps/orchestrator/Dockerfile`, `apps/web/Dockerfile`, `apps/web/next.config.ts`, `apps/web/package.json`, `deploy/docker-compose.yml`, `deploy/docker-compose.dev.yml`, `docs/ARQUITECTURA.md`, `docs/DECISIONES.md`, `package.json`, `pnpm-lock.yaml`, `scripts/check-phase-0-compose.sh`, `tests/phase-0-compose.test.ts`.
- **TDD:** four initial deployment tests failed on missing files; final eight tests passed (two web/six deployment). Narrowed overbroad generated-server exclusion after actual runtime build failure; three writer harness runs passed afterward.
- **Writer checks:** install, tests, lint/typecheck/Go vet, web build, Go test/vet/build, both Compose configs, diff whitespace and runtime harness passed.
- **Independent verifier:** `mup7qz42-5-1bm8` passed `pnpm test`, `pnpm lint`, Go tests, both Compose configs, `git diff --check` and `bash scripts/check-phase-0-compose.sh`. Both three-service stacks healthy, external web/internal Go probes passed, no published Go/DB ports; disposable project resources cleaned. Source checks found no socket/privileged/K6/recorder or severe blocker.
- **Final spot check:** `mup8615z-7-gpkk` passed `pnpm test`: two web plus six deployment tests, zero failures/skips. Non-blocking MODULE_TYPELESS_PACKAGE_JSON warning. No source changes.
- **Limitations:** hosted GitHub CI unexecuted; builds used cache, clean-cache reproducibility untested. Tests approximate Docker ignore and shallow dev merge; actual runtime supplements them. README cleanup 60-second claim omits additional image-operation budgets (low discrepancy).
- **Old resources:** `7ac02bc2301c`, `ebf0c52bde15` exited/unlabeled/no mounts; ownership unproven, left untouched.
- **Assessment:** untracked declaration prevented native risk plan; treated high/unassessable and ran independent verification. Verification grants no native approval.
- **Rollback:** remove/revert only this unit's source surfaces together; retain human env, original docs, tracking and generated outputs.
- **Commit/native review:** pending.

## Delivery strategy
User chose `stacked-to-main` for future review slices, then explicitly accepted one coherent size exception: 578 authored changed lines plus 25 generated lockfile lines, 603 total. Tests depend on Compose/Docker/CI/harness together; do not split into broken intermediate states or rewrite/minify to reduce lines. Parent task document excluded from worker count. No publishing authorized. Slice base `3668187` to deployment commit (identity pending).

## Next step
Reconcile exact candidate paths and human env policy disposition, commit authorized coherent unit, assess/review against recorded base, then stop for human Phase 0 review. All local checks passed; hosted CI and clean-cache builds remain unverified.
