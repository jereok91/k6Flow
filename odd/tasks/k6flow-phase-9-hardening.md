# K6Flow — Phase 9 Hardening

## Objective and boundary
Security hardening, limits, orphan reconciliation, final documentation and deployment guide. Authority is `doc/ptomt_init/promot-init.md` §10 (Security) + §11 (Packaging) + §12 Phase 9. This is the final phase.

## Constraints and accepted intent
- Repository: `/home/jeremy/Proyects/k6flow`, branch `feat/k6flow-phase-9-hardening` (new, stacked on Phase 8 final).
- Local commits authorized; NO push, PR, merge or publishing.
- Strict TDD where applicable. Runner `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`.
- Technical artifacts English; user communication Spanish (Rioplatense).

## Security requirements (init §10)
1. Docker socket access — document risk, apply mitigation (rootless or socket proxy)
2. Allowed targets list — configurable destinations, explicit confirmation before runs
3. SSRF protection — recorder and K6 cannot reach internal network
4. Credentials/CSV — never in logs, minimal retention
5. Secrets — env vars only, `.env.example` without real values
6. Dependencies — pinned versions, basic CI scanning

## Packaging requirements (init §11)
1. docker-compose.yml with web, orchestrator, db, internal network
2. docker-compose.dev.yml with hot reload
3. Multi-stage lightweight Dockerfiles
4. Reverse proxy with HTTPS (Caddy or Traefik — simplest option)
5. Single-command installation, clear VPS deployment README

## Stable work units
- [x] K6F9-01 — Allowed targets configuration: environment-based allowlist for K6 destinations.
- [x] K6F9-02 — Run confirmation UI: explicit confirmation before launching tests.
- [x] K6F9-03 — SSRF protection: network isolation for recorder/K6 from internal services.
- [ ] K6F9-04 — Credential handling: audit logs, ensure no secrets leak.
- [ ] K6F9-05 — Docker socket documentation: document risk, mitigation options.
- [ ] K6F9-06 — Reverse proxy setup: Caddy configuration for HTTPS.
- [ ] K6F9-07 — Deployment README: single-command VPS installation guide.
- [ ] K6F9-08 — Orphan reconciliation: cleanup stale containers/recordings.
- [ ] K6F9-09 — Final documentation review.
- [ ] K6F9-10 — Human Phase 9 review gate (final).

## Acceptance, verification and review strategy
Security: manual audit + tests where applicable. Deployment: test on clean environment. Documentation: completeness check.

Commands: `pnpm test`, `go test ./...`, `pnpm typecheck`, `pnpm lint`, `git diff --check`. Track work-unit commits with Conventional Commits.

## Progress
Latest acknowledged work-unit boundary: (none yet). Next: K6F9-01 allowed targets configuration.
