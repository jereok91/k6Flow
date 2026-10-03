# K6Flow — Phase 4 Visual Editor

## Objective and boundary
Build the visual node editor in `web` (React Flow), the manual-construction nodes of init §3.1, scenario saving and user authentication (init:188, §12). Authority is `doc/ptomt_init/promot-init.md` §§3.1, 9, 10, 12 plus the frozen Phase 1 contracts in `packages/shared` (node parameter schemas, `graph-composition`) — implement them, never change them. Stop for human Phase 4 review before Phase 5 (init:176).

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-4-editor` (new, stacked on Phase 3 final `3f8e0c9`). The declared session cwd does not exist; the repo path above is authoritative.
- Local commits authorized; NO push, PR, merge or publishing. Native receipts are review evidence, not delivery authorization.
- Strict TDD: RED then GREEN. Runner `pnpm test` (726 baseline: 720 vitest + 6 node), `pnpm typecheck` (shared + web with `--incremental false`), `pnpm lint` (= typecheck + `go vet ./...`). Go surfaces are NOT touched by Phase 4; `go vet` must stay green. Technical artifacts English; user communication Spanish (Rioplatense).
- Approved product decisions (human, 2026-10-02):
  1. **Database: PostgreSQL** — the `db` service already exists in `deploy/docker-compose.yml` (postgres:17.7-alpine3.22, backend network, healthcheck, named volume).
  2. **User auth: own credentials** — username + password hashed with **scrypt** (`node:crypto` stdlib, zero new deps for hashing), opaque session token in an **httpOnly** cookie. No OAuth.
  3. **Roles: `admin` + `user`** — admin manages users (create/delete/assign role) via UI; both roles create scenarios and run tests.
  4. **DB access: Drizzle ORM** — driver `pg` (node-postgres) + `drizzle-kit` for migrations. Justification: mature, works with the existing `pg` ecosystem, drizzle-kit generates plain SQL migrations. This driver choice is a documented sub-decision of the approved Drizzle choice, not a new product decision.
  5. **Human-authorized `deploy/**` edit** (2026-10-02): wire `web`→`db` in `deploy/docker-compose.yml` + `deploy/docker-compose.dev.yml` and add `DATABASE_URL` to `deploy/.env.example`. `.env.example` stays WITHOUT real secrets (existing `POSTGRES_PASSWORD` line is unchanged and human-owned).
- New dependencies (each human-approved or a documented sub-decision): `@xyflow/react` (React Flow — named in init §2.1), `drizzle-orm`, `pg`, `@types/pg`, `drizzle-kit` (dev). Version-pinned; `pnpm-lock.yaml` updated in the unit that introduces them.
- Sessions are DB-backed (opaque token in `sessions` table), NOT stateless JWT: revocable on logout, no secret signing key to manage. Documented in DECISIONES.
- Scenario graphs are persisted as validated JSONB and must round-trip through the Phase 1 `graphDraftCompositionSchema` — the editor stores drafts; readiness/topology rules stay owned by shared contracts.
- The editor never talks to the orchestrator in Phase 4 (that is Phase 5). No K6 script generation, no run launching from the editor.
- Advisory backlog from Phases 1–3 stays unauthorized (native informational warnings + the recorded deferrals).
- `deploy/.env.example`, `deploy/docker-compose*.yml` are human-owned: edits only in K6F4-01, only the authorized web→db wiring, quoted verbatim in DECISIONES.
- **Phase 0 test amendment (human disposition 2026-10-02)**: `tests/phase-0-compose.test.ts` asserts `DATABASE_URL` is absent on BOTH `web` and `orchestrator`, which blocks the approved web→db wiring. Disposition: amend to allow `DATABASE_URL` on `web` ONLY (orchestrator stays strictly DB-free), keeping `depends_on === undefined` and the process-only `/api/healthz` probe intact — the real "process health is independent of DB" invariant is preserved; only the blanket env-absence assertion is narrowed. Authorization comment citing 2026-10-02 + Phase 4 required, same pattern as the K6F3-01 dev-socket amendment.
- **Budget disposition (human, 2026-10-02)**: K6F4-01 projected ≈678 authored lines (≈411 hand-written + ≈267 drizzle-kit generated), over the ~500 gate. Human chose SPLIT: 01a (schema/migrations/client ≈436) and 01b (password/seed/wiring/Phase 0 ≈244), each under 500 even counting generated artifacts. The native-review diff counts generated migration files (Phase 3 ruling governs authored diff lines), so the split keeps each review slice within budget.
- **Admin seed mechanism (engineering decision)**: an explicit CLI seed script (`pnpm --filter @k6flow/web seed`) reading `ADMIN_USERNAME` + `ADMIN_PASSWORD` from env, erroring when absent/blank/short. NOT auto-seeded on web boot — keeps the secret out of the long-running process env and makes the first-admin step deliberate (init §10: secrets only via env). Documented in DECISIONES. Lives in K6F4-01b.

## Stable work units
- [ ] K6F4-01a — DB schema foundation: Drizzle schema (`users`, `sessions`, `scenarios`), migrations, `drizzle.config.ts`, DB client singleton. NO compose wiring, NO seed, NO password helpers (those are 01b). Budget disposition: split 2026-10-02 (original projection ≈678 over the ~500 gate; 01a ≈436, 01b ≈244).
- [ ] K6F4-01b — Auth storage + wiring: scrypt password helpers, admin seed CLI, `web`→`db` compose + `.env.example` wiring, Phase 0 test amendment (DATABASE_URL on `web` only).
- [ ] K6F4-02 — Auth core: scrypt hash/verify, DB-backed sessions, httpOnly cookie, `login`/`logout`/`me` API, route protection middleware.
- [ ] K6F4-03 — User management: admin-only REST + admin UI page (create/delete users, assign role).
- [ ] K6F4-04 — Scenario persistence: CRUD API scoped by ownership (admin sees all), graph validated against `graphDraftCompositionSchema`.
- [ ] K6F4-05 — React Flow editor: node palette, canvas, §3.1 node config panels, pure TDD core mapping React Flow graph ↔ `GraphDraftComposition`.
- [ ] K6F4-06 — Editor↔scenario wiring + real-Docker end-to-end proof (login → draw → save → reload).
- [ ] K6F4-07 — Human Phase 4 review gate (init:176).

## Acceptance, verification and review strategy
Each unit: RED/GREEN with `pnpm test`; pure logic (scrypt, session tokens, scenario validation, graph↔contract mapping) fully unit-tested with no DB; repositories kept thin and proven in the K6F4-06 real-stack e2e (login, save, reload). Components stay thin per the K6F3-04 precedent (no component-testing library in repo; behavior lives in tested `lib/` modules). Auth negatives required: wrong password, expired/revoked session, non-admin on admin routes, unauthenticated on protected routes. Cookie flags asserted (`httpOnly`, `SameSite`, `Secure` behind HTTPS). Scenarios: owner-scoped reads/writes, admin visibility, malformed graph rejected, valid draft round-trips byte-equal.

Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Phase 4 adds no Go code; the Go runner commands are unchanged and out of scope. Native assessment on new files is usually unassessable → independent verifier required (Phase 1/2/3 precedent). Track work-unit commits with Conventional Commits; review each committed range with an explicit baseRef (Phase 2 lesson); no delivery authorized. Budget planning ≈700 authored lines per unit (TS/web); over ~500 triggers a pre-authoring human disposition (accept/trim/split), per the Phase 3 ruling that the expectation governs authored lines.

## Closed work evidence
| Phase | Status | Evidence |
|---|---|---|
| Phase 1 (contracts) | Gate 07 approved 2026-10-01 | `odd/tasks/k6flow-phase-1-contracts.md` — 675 TS tests |
| Phase 2 (execution core) | Gate 06 approved 2026-10-02 | `odd/tasks/k6flow-phase-2-execution-core.md` — 207 Go + 23 integration + 675 TS |
| Phase 3 (live metrics) | Gate 05 approved 2026-10-02 | `odd/tasks/k6flow-phase-3-metrics-live.md` — 291 Go unit + 47 integration RUN + 726 TS; tail `87120ad`+`035ac05` closed on independent verification, HEAD `3f8e0c9` |

Latest acknowledged work-unit boundary: none in Phase 4 yet.

## Research evidence
- init:188 — Fase 4 literal: React Flow, nodos de la sección 3.1, guardado de escenarios y autenticación de usuarios.
- init §3.1 — nodos manuales: autenticación/token, petición HTTP, validación de respuesta, pool de usuarios CSV (SharedArray), configuración global (VUs, duración, rampas, thresholds).
- init §9 — pendientes resueltos por el humano para esta fase: base de datos (PostgreSQL), autenticación (credenciales propias) y roles (admin + usuario).
- init §10 — secretos solo por env, `.env.example` sin valores reales; credenciales de prueba nunca en logs.
- Phase 1 contracts: `packages/shared/src/{graph,graph-composition,auth-parameters,http-parameters,check-parameters,csv-pool-parameters,load-parameters,parameter-values}.ts` — nodos §3.1 ya tipados.
- Infra: `deploy/docker-compose.yml` (`db` service postgres:17.7, backend network, healthcheck), `deploy/.env.example` (WEB_PORT/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD).
