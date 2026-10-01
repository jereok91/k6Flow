# Foundation decisions

## Phase 1 — shared validation foundation (K6F1-01)

Use private `@k6flow/shared` for runtime validation and schema-inferred types.
It exports TypeScript source; no build artifacts or service runtime are introduced.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Zod 4.6.5, exact dependency pin | Human-approved validator supplies validation and inferred types from one schema. |
| TypeScript 5.9.3 | Reuses the web toolchain version; shared strict, no-emit checking runs through root lint, including shared tests. |
| Numeric literal `version: 1` | Minimal technical discriminator, without coercion or defaults; unsupported versions fail validation. |
| Strict `{ version: 1 }` foundation | Unknown fields fail; this is not a graph, REST or WebSocket payload. Future schemas must explicitly define their own fields. |
| Shared Vitest discovery | Adds shared tests while preserving web tests and the separate deployment-contract runner. |

### Dependency selection evidence

Read-only npm registry query on 2026-10-01:
`https://registry.npmjs.org/zod/latest` returned stable version `4.6.5`.
Tarball: `https://registry.npmjs.org/zod/-/zod-4.6.5.tgz`.
Registry integrity:
`sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==`.
This records the selection source, not an independent security assessment.

### Boundary and verification

Run `pnpm test`, `pnpm lint` and `git diff --check` from the root.
Web typechecking disables incremental output to keep validation read-only.
Runtime harness: N/A; validation adds no process or network boundary.
Rollback the shared package, workspace/test/typecheck wiring, lockfile changes
and these Phase 1 notes together; preserve all Phase 0 behavior and decisions.
Graph semantics, REST behavior and WebSocket routing remain outside this unit.

## Phase 1 — graph structure and reference invariants (K6F1-02)

Use separate draft-structure and execution-topology validators; neither establishes
full execution readiness. See [the graph contract](api/graph.md) for the shape.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Strict version 1 structural objects | Required identified nodes, directed connections and explicit producer/output references; malformed fields, duplicate IDs/connections and dangling identities fail even in drafts. |
| Retain unfinished draft topology | Empty/disconnected drafts and references to existing self/later producers are storable; traversal constraints apply only at the execution-topology boundary. |
| One linear path per VU | Human-approved no-branch/no-cycle contract; iterative connection traversal rejects forks, merges and disconnected components without relying on array order. |
| Earlier-producer references | Execution topology requires producer rank before consumer rank; output strings are opaque names, not proof of output support. |
| Structural-only exports | `graphDraftStructureSchema` and `graphExecutionTopologySchema` explicitly avoid a broad executable schema; parameters, load and output semantics remain K6F1-03. |

Runtime harness: N/A; these pure validators introduce no process/network boundary.
Rollback only `packages/shared/src/graph.ts`, its tests and graph exports,
`docs/api/graph.md` and this decision section; preserve the foundation and tracking.

## Phase 1 — standalone values and HTTP parameters (K6F1-03a)

Use additive standalone schemas and inferred types; preserve graph behavior.
See [the HTTP wire contract](api/graph.md#standalone-http-parameters-k6f1-03a).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Human-selected whole literal/reference values | No interpolation or segments; references cannot add a URL path or token prefix. Expected string/JSON kind belongs to the consuming field, not an unchecked reference annotation. |
| Strict `kind` tags and nested `reference` identity | Engineering wire discriminators; reuse the graph identity schema without changing graph objects or claiming producer/output validation. |
| None, text and structured JSON bodies | Human-approved initial formats; JSON references replace the whole value. Nested reference-looking literal objects are data, not expressions. Forms/multipart/files remain deferred. |
| Finite plain JSON data | Reject executable/native values, cycles, accessors and lossy non-JSON properties; validation neither invokes getters nor performs interpolation. |
| Optional ordered header/query arrays and body | Preserve absence, duplicates and input order without defaults/transforms. Method accepts HTTP token syntax including extension methods; runtime encoding and method semantics are not implemented. |

K6F1-03f owns parameter/graph reference reconciliation and output compatibility
once producer contracts exist. This unit provides no auth/extraction/check/load
contracts, transport, URL security policy or execution-readiness guarantee.
Runtime harness: N/A; validation-only changes add no process/network boundary.
Rollback only standalone values/HTTP modules and tests, their additive exports,
the HTTP guide section and these decision notes; keep existing graph contracts.

## Phase 0 decisions

These decisions implement the approved foundation without deciding later
product contracts. The original product and UX inputs under `doc/` are preserved.

| Decision | Rationale / consequence |
|----------|-------------------------|
| PostgreSQL 17.7, Alpine 3.22 | PostgreSQL was explicitly selected; named-volume persistence uses the version 17 data directory. |
| Node 22.22.0, pnpm 10.32.1 | Compatible with Next 16.1.6 and the existing pinned workspace; explicit image/toolchain versions avoid floating `latest`. |
| Go 1.25.7, Alpine 3.23 | Supports the module's Go 1.22 language baseline; the binary needs no C runtime. |
| Alpine 3.23.3 Go runtime | BusyBox provides the HTTP health probe without adding a reload or probe framework. |
| Next standalone production output | Copies only runtime dependencies and generated assets into a non-root final image. |
| Process-only web/Go health | No database client exists yet; a green process must not imply DB connectivity or application readiness. |
| Internal backend; loopback web binding | Go/database have no published ports; web is local-only until HTTPS and access control are designed. |
| Web app reload; manual Go restart/rebuild | Native Next development behavior and Go tooling suffice; no reload framework dependency. |
| TypeScript checking and Go vet baseline | Uses available tooling for meaningful static checks; no gratuitous ESLint dependency or style-policy invention. |
| YAML parser in deployment tests | Checks structured service/network/health contracts instead of formatting snapshots. |
| Allowlisted Docker build context | Excludes secrets, host outputs and original assets without changing `.gitignore`. |
| Disposable runtime projects | Real startup tests must not adopt an existing stack or delete its data; startup/cleanup failures stay failures. |

## Constraints and operational caveats

Version tags are pinned, not immutable digests. Updates and vulnerability scanning
policy remain future hardening; this CI provides checks, not a security certification.
The dummy example is for local disposable use only. Production credentials belong
outside the repository; existing database credentials require explicit rotation.
The database volume persists through ordinary `down` and must be backed up before
any deliberate deletion or upgrade. A development Go bind includes the source
directory, so keep real credentials outside that directory as well.

## Pending human decisions

Authentication and roles, retention, WebSocket routing, Playwright versus
Puppeteer, reverse proxy/HTTPS and Docker Engine privilege mitigation remain
unresolved. Phase 0 does not implement them, grant socket access or simulate them
through placeholder product endpoints. Stop for review before Phase 1.
