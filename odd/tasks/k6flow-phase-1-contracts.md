# K6Flow — Phase 1 Contracts

## Objective and boundary
Define shared graph, REST and versioned WebSocket contracts before runtime implementation. Human approved Phase 0 with `go`; authority is `doc/ptomt_init/promot-init.md` §§5, 12. Stop for human Phase 1 review before Phase 2. Typed declarations do not establish execution readiness or implement runtime behavior.

## Constraints and accepted intent
- Repository branch: `feat/k6flow-phase-1-contracts`; delegated organic work, not SDD. Parent owns this document, lifecycle and commits; writers own bounded source surfaces.
- Local commits authorized; no push, PR, merge or publishing. Native receipts are review evidence, not delivery authorization.
- Strict TDD: observe behavioral RED then GREEN with `pnpm test`. Technical artifacts English; user communication Spanish.
- Preserve init/UX documents, root `.gitignore` and generated outputs. Human-owned `deploy/.env.example` is prohibited to read, write or stage.
- No handlers, translators, UI, recorder runtime, Docker Engine access, migrations or product-login implementation.
- Zod 4.6.5 explicitly approved; TypeScript 5.9.3 and Vitest 4.0.18 retained. Registry evidence and product decisions live in `docs/DECISIONES.md`.
- Linear execution per VU, no cycles/forks/merges. Connections determine precedence; explicit producer/output references consume earlier results. Draft retention and structural execution-topology validation are separate; full readiness remains 03f.
- HTTP URL/header/query values are whole literals or references, never interpolation/segments. Bodies: none, text, structured JSON. Forms/multipart deferred; reference-shaped literal JSON stays data.
- Scenario authentication: configured HTTP request, uniquely named required JSON-path/header/cookie outputs, explicit string/JSON types. Missing required output/type mismatch declares stop-current-VU-iteration. No Basic Auth/OAuth2, cookie-jar or runtime assumptions approved.
- Checks: explicit response reference; unique independent names; numeric status/duration-ms comparisons; text/header existence, literal equality/inequality and contains; structured JSON-path existence/deep literal equality. Fixed record-failure-and-continue, including missing field/type mismatch. No regex, callbacks or executable expressions.
- Runtime ambiguity (header case/repetition, cookies, transport/invalid JSON) and graph-wide producer/type compatibility remain deferred. REST/WS/recorder/pool/load decisions require focused human approval.
- Generated install surfaces: `node_modules/**`, `apps/web/node_modules/**`, `packages/shared/node_modules/**`. Explicit verification writes/downloads: `node_modules/.go-cache/**`, `node_modules/.go-mod-cache/**`; human subsequently approved generated `node_modules/.vite/**` writes to retain `pnpm test`. Never delete, stage or commit caches/dependencies/`.codegraph/`. Only previously authorized repository-local Git exclusions; no tracked/global ignore changes.

## Stable work units
- [x] K6F1-01 — Shared foundation, workspace/test discovery and strict typechecking.
- [x] K6F1-02 — Draft integrity, iterative linear topology and earlier references; structure only.
- [ ] K6F1-03 — Typed node/load contracts; capability subunits replace invalidated 250–380-line total forecast.
  - [x] K6F1-03a — Literal/reference values and standalone HTTP parameters.
  - [x] K6F1-03b — Standalone HTTP authentication/extraction declarations.
  - [ ] K6F1-03c — Structured checks. P2 resolved; full independent reverification passed. Commit/native review pending. Forecast 220–330 lines.
  - [ ] K6F1-03d — CSV pool contract. Pending allocation/attachment/exhaustion choices; forecast 200–300.
  - [ ] K6F1-03e — Global load/thresholds. Pending executor/predicate choices; forecast 230–350.
  - [ ] K6F1-03f — Typed draft/executable composition, producer outputs, compatibility and embedded-reference reconciliation; forecast 300–400.
- [ ] K6F1-04 — Runs/health REST schemas and OpenAPI agreement; pending semantics, forecast 300–400.
- [ ] K6F1-05 — Versioned metrics WS; pending routing/units/aggregation/ordering, forecast 180–300.
- [ ] K6F1-06 — Recorder REST/WS contracts; pending lifecycle/wire decisions, forecast 250–400.
- [ ] K6F1-07 — Human Phase 1 review gate.

## Acceptance, verification and review strategy
Each capability needs strict schemas/inferred exports, behavioral RED/GREEN, positive/negative/boundary tests, English documentation and unchanged reviewed contracts. Draft integrity must reject malformed/duplicate/dangling identities without claiming readiness. Composition must prove supported outputs/type compatibility/precedence only after producer contracts exist. REST/WS contracts require schema/document agreement and explicit versioning.

Commands: `pnpm test`; `GOCACHE="$PWD/node_modules/.go-cache" GOMODCACHE="$PWD/node_modules/.go-mod-cache" pnpm lint`; `git diff --check`, plus both untracked-file whitespace checks when needed. No-index exit 1 without diagnostics means differences, not whitespace failure. Historical RED is writer-observed, not independently reproduced. Runtime N/A because these units expose declarations/validation only; actual extraction/check evaluation/process/network execution is not verified.

Native assessment repeatedly fails on undeclared new files; treat as unassessable/high and obtain independent verification. Precisely stage coherent source/tests/docs/tracking, reconcile actual Git counts, then inspect committed ranges and acknowledge provider approval exactly. Keep ~400 authored diff lines per coherent slice; Phase 0 exception does not transfer. Forecast Phase 1 2,580–3,790 lines; node/load 1,530–2,160. Future delivery strategy `stacked-to-main`, but no PR authorized. Rollback a capability's modules/tests/additive exports/notes together, preserving prior contracts and human surfaces.

## Closed work evidence
| Unit | Commit | Verification | Acknowledged native review |
|---|---|---|---|
| 01 | `810873d38a33d33525809de48fd7770457bec12b` | 23 tests, isolated lint, whitespace; verifier `mupaqb7m-e-c0j5` | `review-0734a03fbfca52ba`, medium, one reviewer, 176 total diff lines |
| 02 | `eca5117a31976405ffc9c68b6a6cd1ac1a9494ec` | 63 tests including 12,000-node chain, lint, whitespace; verifier `mupbcm1h-h-if5y` | `review-924bda01a4756696`, medium, one reviewer, 332 lines |
| 03a | `0183c6aad8bbd11120e8d712901e374aa287eddc` | 120 tests, lint, whitespace; verifier `mupc1av0-k-oz75` | `review-65ac448e67f6d913`, medium, one reviewer, 310 lines |
| 03b | `c32c98aba38651e7a14941c7a9c14aca804e3ef7` | 172 tests (52 auth), lint/Go vet, whitespace; verifier `mupcq7j2-m-ayvn` | `review-12b5cede3f2debad`, high/auth signal, four reviewers, 307 lines |

Current reviewed boundary: `c32c98aba38651e7a14941c7a9c14aca804e3ef7`, tree `86479967471121881c254f4f2a383e82e9386297`. Auth source count corrected to 295 additions/1 deletion (296), not writer-reported 297; commit includes tracking, 302 additions/5 deletions. Auth target `sha256:b35c2cad2124bdc59143fcc822f55efe886d40db3cb99e94fab3099254857f6f`, consumed revision `sha256:84b0174f4231d8286b7fdfbaa0fbec5df02067823ed8983fd591069e9191883d`; authority burned. Earlier detailed evidence remains in committed task revisions and project observations; this document retains current intent rather than an exhaustive event journal.

Nonblocking advisories remain separate later work: `R3-proxy-parse` (`parameter-values.ts:27-28`), `R3-wrapper-accessor` (`parameter-values.ts:54`), `R2-http-token-schema-name` (`auth-parameters.ts:12-13`). No correction/reopening authorized. Earlier partial tracking START stopped pre-authority at untracked selection; no lineage/capture or partial approval claimed.

## Active correction and next action
Initial 03c writer `mupmerro-n-vbih`: 263 additions/1 deletion, 57 new tests, 229 tests/lint passed. Verifier `mupmn6fo-o-14dx` nevertheless returned FAIL: P2 missing approved text/header `ne` at `check-parameters.ts:11–15`, with tests wrongly rejecting it. No commit/review proceeded.

Verifier also reported generated `node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json` outside its delegated cache scope and platform output spill `/tmp/pi-bash-aedd6651574bbdaf.log`. Artifacts left untouched; human subsequently authorized generated `.vite/**` writes, not retrospective acceptance or wider temp access. Avoid large metadata scans; no cleanup authorized. Ignored-output/byte-level preservation was not independently established.

Correction writer `mupn6hw8-p-i1a4`: positive text/header `ne` RED observed (2 failed/220 passed; invalid discriminator), then GREEN, final 231 tests (225 Vitest/6 deployment), 59 checks, isolated lint and both new-file whitespace checks passed. Fixed strict string `ne`, rejected missing/wrong expected/extras and JSON-ne; documented inequality. Reported full candidate 267 additions/1 deletion (268), excluding parent tracking. Reviewed modules unchanged; model `gpt-6.1-sol`, effort unavailable.

Fresh assessment still unassessable. Reverifier `mupnbpeq-q-guwv` independently PASS: 231 tests (225 Vitest/6 deployment), 59 checks, lint/Go vet, tracked and both new-file whitespace checks; reviewed modules unchanged. Confirmed full candidate 267 additions/1 deletion excluding tracking. P2 resolved; parent tracking hash/status preserved during verification, observed Vitest cache update authorized. Historical cache incident retained. Correction closed; commit/native review next. Parent bookkeeping is separate scope, not covered by auth approval. Next after 03c closure: focused human CSV pool choices. Hosted CI/clean-cache reproducibility remain unverified.
