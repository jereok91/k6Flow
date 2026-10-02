# K6Flow — Phase 2 Execution Core

## Objective and boundary
Implement the Go orchestrator runtime: launch a K6 script in a container, monitor it, stop it and clean it up (init:184, §7). No interface yet; verify with `curl`. Human approved Phase 1 gate (K6F1-07, commit `12bf8f8`); authority is `doc/ptomt_init/promot-init.md` §§5.1, 7, 12. Stop for human Phase 2 review before Phase 3 (init:176). Phase 2 is runtime code — declarations alone no longer suffice; behavior must be proven by tests.

## Constraints and accepted intent
- Repository branch: `feat/k6flow-phase-2-execution` (stacked on Phase 1 HEAD `12bf8f8` of `feat/k6flow-phase-1-contracts`). Parent owns this document, lifecycle and commits; writers own bounded surfaces.
- Local commits authorized; no push, PR, merge or publishing. Native receipts are review evidence, not delivery authorization.
- Strict TDD: observe behavioral RED then GREEN; Go tests `go test ./...` with `GOCACHE="$PWD/node_modules/.go-cache" GOMODCACHE="$PWD/node_modules/.go-mod-cache"`; web/TS tests stay `pnpm test`. Technical artifacts English; user communication Spanish.
- Preserve init/UX documents, root `.gitignore` and generated outputs. Human-owned `deploy/.env.example` is prohibited to read, write or stage (use `deploy/.env.example` only as untouched reference; document new env vars in DECISIONES and compose files if needed — `deploy/docker-compose*.yml` edits require parent review).
- Zod 4.6.5, TypeScript 5.9.3, Vitest 4.0.18 retained; Go 1.22, official Docker SDK for Go (`github.com/docker/docker`) approved as the container runtime (init §7 requirement; new Go dependency is authorized by init, recorded in DECISIONES).
- Four approved Phase 2 policies (human, 2026-10-02):
  1. **REST scope**: full approved contract 04 — POST `/api/runs` → 202 + runId (async), `Idempotency-Key` dedupe → 200 with existing runId, POST `/api/runs/{runId}/stop` → 202, GET `/api/runs/{runId}` state, GET `/api/runs/{runId}/summary`, 404 unknown runId, 409 premature summary, exact statuses `pending|running|finished|failed|stopped`, static Bearer auth on all `/api/*` (401), explicit `version: 1` on API bodies, public unversioned `/healthz` preserved untouched.
  2. **Script**: the run-start request's opaque script string IS the executed script (contract 04 wins over literal init:184 "script fijo"; init predated the translator, and Phase 2 has no translator — humans supply the script via curl).
  3. **Runtime + tests**: Go `ContainerRuntime` interface with an in-memory fake for fast unit TDD, plus real-Docker integration tests behind `//go:build integration` using the host Docker engine (29.8.1 verified present) and the `grafana/k6` image. Official Docker SDK; no shell-outs to the `docker` CLI.
  4. **Summary**: minimal JSON output parse at run end → cumulative totals (requests/errors/failed checks), latency avg/p90/p95/p99 (ms), `thresholdsPassed` boolean, honoring the approved 04 summary contract. Full streaming/broadcast stays Phase 3.
- Container lifecycle (init §7): one container per run, CPU/memory limits (`cpuMillis`/`memoryMiB` required positive safe ints per contract 04), controlled network, guaranteed removal on finish/fail/stop/cancel, orphan reconciliation at startup (reconcile containers left by a previous orchestrator process). Secrets never persisted longer than necessary.
- Concurrency: safe goroutines, context cancellation, graceful shutdown; structured logs; config via env vars; configurable max concurrent runs and max VUs per run (init §7 — guard the VPS).
- Contract 04 schemas are TypeScript declarations in `packages/shared`; the Go side implements equivalent behavior with Go tests asserting parity (text-level agreement where practical). Web UI, WS metrics, translator, CSV pool, recorder runtime remain out of scope (Phases 3–8).
- Idempotency store is in-memory for Phase 2 (no DB); durability across restart is Phase 9 hardening.

## Stable work units
- [x] K6F2-01 — Orchestrator Go foundation: config/env, structured logging, run store (statuses, idempotency map), ContainerRuntime interface + fake. Test-first. COMPLETE (pending commit): writer `muqct1k0-8-uj27`, split into two passes by human disposition (initial full-scope projection ≈730 exceeded the ~450 stop). Pass A: `internal/config` (Config/Load, defaults-only-absent, invalid⇒error, fail-closed SERVICE_TOKEN) + `internal/runtime` (ContainerRuntime interface, Spec, thread-safe FakeRuntime) — package restructure from `internal/runs` to make each pass independently GREEN. gofmt disposition: +73 lines accepted (pass A = 473). Pass B: `internal/runs/store.go` (230 lines, gofmt-canonical first write) — exact 5 statuses, legal-transition table (all 25 pairs tested), terminal immutability, crypto/rand run ids, NUL-separated dedupe index (empty key never matches), detached Summary copy. Full battery: `go test ./...` 53 runs 0 FAIL (4 packages), `-race` exit 0, `go vet` exit 0, `gofmt -l` empty. Six-file total 889 lines (A=473, B=416) — human disposition: accept as-is (2026-10-02), overriding original 300–400 target; two chained commits planned.
- [ ] K6F2-02 — REST handlers for contract 04 (start/stop/state/summary + Bearer auth middleware + version validation) wired to the fake runtime; curl-verifiable.
- [ ] K6F2-03 — Docker runtime implementation: SDK lifecycle (create/start/wait/stop/remove), CPU/mem limits, script delivery, guaranteed cleanup, startup orphan reconciliation, concurrency limits.
- [ ] K6F2-04 — K6 JSON output parsing → approved summary shape (totals, latencies, thresholdsPassed) integrated into run completion.
- [ ] K6F2-05 — Real-Docker integration tests (`//go:build integration`): launch/monitor/stop/cleanup against host engine with `grafana/k6`; evidence of guaranteed removal.
- [ ] K6F2-06 — Human Phase 2 review gate (init:176).

## Acceptance, verification and review strategy
Each unit: RED/GREEN with `go test ./...` (unit) and `pnpm test` when TS surfaces are touched; structured logs; no secret leakage in logs/tests. Integration unit (05) proves real container lifecycle; its absence must be explicit (build tag documented), never silently skipped in reports. REST behavior must match contract 04: assert status codes, `version: 1`, Bearer 401, idempotency dedupe, 404/409 semantics with table tests.

Commands: `GOCACHE="$PWD/node_modules/.go-cache" GOMODCACHE="$PWD/node_modules/.go-mod-cache" go test ./...`; same env + `go vet ./...` and `pnpm lint`; `git diff --check` plus untracked whitespace checks. Integration: `go test -tags integration ./...` (requires host Docker; report skip/failure explicitly).

Native assessment frequently returns unassessable on new files → independent verifier required (Phase 1 precedent). Keep ~400 authored diff lines per coherent slice; overages need human disposition (accept/trim/split). Track work-unit commits locally with Conventional Commits; no delivery authorized. Rollback a unit's modules/tests/config together.

## Closed work evidence
| Unit | Commit | Verification | Acknowledged native review |
|---|---|---|---|
(Phase 1 evidence lives in `odd/tasks/k6flow-phase-1-contracts.md`; Phase 1 final boundary `12bf8f8` on branch `feat/k6flow-phase-1-contracts`, 675 tests GREEN, gate 07 approved by human.)

Latest acknowledged work-unit boundary: none in Phase 2 yet.

## Research evidence
- init:184 — Fase 2 literal scope: launch fixed K6 script in container, monitor, stop, cleanup; no UI; test with curl.
- init §7 — official Docker SDK, per-run container, CPU/mem limits, controlled network, guaranteed removal incl. orphan reconciliation on restart, script delivery without lingering secrets, JSON streaming output, safe concurrency + graceful shutdown, structured logs, env config, configurable max concurrent runs/max VUs.
- init §5.1 — REST surface (runs lifecycle, stop, summary, healthz), internal-network-only exposure, shared-token service auth.
- Contract 04 (`docs/api/runs.md`, `docs/api/openapi.yaml`) — approved request/response shapes, statuses, idempotency, error catalog, `version: 1`.
- Environment: Docker engine 29.8.1 on host; `apps/orchestrator` Go 1.22 module with 29-line healthz server; `deploy/docker-compose.dev.yml` mounts orchestrator source read-only.
