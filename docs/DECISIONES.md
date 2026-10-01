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

## Phase 1 — target authentication and extraction declarations (K6F1-03b)

Use standalone `authParametersSchema` for scenario external-target login, not
K6Flow user authentication. See [the auth wire contract](api/graph.md#standalone-target-authentication-k6f1-03b).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Tagged HTTP-only method with reused request schema | Human-approved configurable request; preserve reviewed HTTP/value/graph behavior. No Basic Auth/OAuth2 variants or credentials in examples. |
| Unique required named outputs | Reuse graph output identity; nonempty outputs and explicit `required: true` avoid inventing optional-output behavior. Names compare exactly. |
| Structured JSON keys/indices or named header/cookie | No expression evaluator; token syntax validates selector names. Keys are data, including prototype-sensitive names; future resolution must use own JSON properties only. Empty path denotes the JSON root. |
| Explicit `string` / `json` expected category | Align with existing parameter consumers; JSON includes strings and null. Header/cookie declarations must be string; compatibility validation belongs to K6F1-03f. No serialization or coercion. |
| Literal `stop-current-vu-iteration` failure policy | Human-approved missing/type-failure outcome affects this iteration only, not other VUs. Validation declares it without implementing control flow. |

Optional outputs, repeated header/cookie matching, cookie ambiguity, invalid JSON,
transport/login failure handling and cookie persistence remain runtime decisions.
No token transformation, secret binding, extraction engine or graph composition.
Runtime harness: N/A; pure validation adds no process/network boundary.
Rollback only `auth-parameters.ts`, its tests, additive auth exports, the auth guide
section and these notes; preserve existing HTTP/value/graph contracts and tracking.

## Phase 1 — standalone structured response checks (K6F1-03c)

Use strict version 1 `checkParametersSchema` and inferred types independently of
reviewed graph/HTTP/value/auth contracts. See [the checks guide](api/graph.md#standalone-response-checks-k6f1-03c).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Explicit consuming response producer/output | Reuse structural identity; no implicit latest response or supported-output claim. K6F1-03f owns compatibility and precedence. |
| Unique named independent checks | Exact identities and stable duplicate issue paths preserve individual results; no runtime result envelope yet. |
| Structured numeric/text/JSON predicates | Human-approved comparisons only; finite numeric literals, literal text equality/inequality/containment and literal JSON equality data. No regex, code, interpolation or secret binding. |
| Reuse reviewed path segments | Root/key/index semantics match auth without modifying reviewed source; reference-looking JSON remains data. |
| Fixed record-failure-and-continue declaration | Failed checks, absent fields and incompatible actual types fail independently without aborting iteration; validation implements no check execution/control flow. |

Header matching/repetition, response ambiguity, runtime coercion, invalid response
JSON and transport behavior remain deferred. No response resolver or graph binding.
Runtime harness: N/A; validation-only declarations add no process/network boundary.
Rollback only check modules/tests, additive check exports, the checks guide section
and these notes (including its HTTP deferred-check wording update); preserve all
reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — standalone CSV pool declarations (K6F1-03d)

Use strict version 1 `csvPoolParametersSchema` and inferred types without changing
reviewed graph/value/HTTP/auth/check contracts. See [the CSV guide](api/graph.md#standalone-csv-pool-declarations-k6f1-03d).

| Decision | Rationale / consequence |
|----------|-------------------------|
| External attachment identity only | Human-approved source boundary; strict opaque nonblank `{ id }`, not inline CSV or URL/path/secret alternative fields. Identity validation supplies no resolver or security guarantee. |
| Explicit stable CSV-order distinct row per VU | Each VU keeps its assigned row across iterations; no sharing, wrapping, random allocation or iteration rotation. Assignment is not implemented. |
| Explicit reject-before-execution capacity policy | A future consumer must fail before execution when distinct rows cannot cover required VUs; standalone validation neither counts rows nor proves capacity/readiness. |
| Nonempty required header-to-string mappings | Exact named headers map to unique structural output identities; required/string literals prevent optional outputs, conversion or trimming. Repeated source-header mappings with different output names are allowed, without deciding duplicate actual CSV-header handling. |
| Phase 6 ingestion and security obligations | SharedArray loading, column presence, capacity and assignment remain future work. Consumers must avoid CSV/credential logs and minimize retention; neither control is enforced here. |

CSV dialect/encoding, duplicate actual headers, malformed rows and VU assignment
mechanics remain deferred, with no implicit defaults. K6F1-03f owns output catalogs,
type compatibility, reference reconciliation and execution readiness.
Runtime harness: N/A; pure declarations add no ingestion, process or network boundary.
Rollback only CSV modules/tests, additive CSV exports, the CSV guide section and
these notes; preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — standalone global load and thresholds (K6F1-03e)

Use strict version 1 `loadParametersSchema` and inferred types without changing
reviewed contracts. See [the load guide](api/graph.md#standalone-global-load-and-thresholds-k6f1-03e).

| Decision | Rationale / consequence |
|----------|-------------------------|
| One tagged global profile | Human-approved constant-VU duration or staged/ramping VUs; no per-node overrides, concurrent scenarios, iterations or arrival-rate executors. |
| Explicit safe-integer milliseconds and VUs | Durations and constant VUs are positive; staged startup/targets are nonnegative with some positive load. Nonempty stages retain input order, including ramp-down to zero; no defaults, coercion or quantity/unit alternatives. |
| Structured HTTP thresholds with explicit units | Latency Trend avg/p90/p95/p99 uses finite nonnegative milliseconds, including fractions. Failure Rate uses finite fractions `[0,1]`. Strict metric/aggregator/unit pairings prevent conversion ambiguity; no custom metrics, tags or arbitrary percentiles. |
| Explicit possibly empty threshold list | Empty declares no threshold criteria. Repeated metrics are valid, consistent with k6 threshold arrays; no unique metric, ID or label requirement. |
| Six numeric operators and fixed final pass/fail | Reuse eq/ne/lt/lte/gt/gte without evaluating predicates. End-of-execution intent excludes early abort/delay; response checks remain record-failure-and-continue. |

Parent-provided primary evidence: [Grafana threshold guide](https://grafana.com/docs/k6/latest/using-k6/thresholds/)
for final pass/fail, Trend milliseconds and abort distinctions; [k6 v0.55.0 parser](https://raw.githubusercontent.com/grafana/k6/v0.55.0/metrics/thresholds_parser.go)
for corresponding numeric comparators. This is not installed-runner/version proof.
Engine-specific duration representability, graceful-stop and startup-delay settings
remain later decisions. REST precedence/status mapping belongs to K6F1-04; graph
composition/readiness to K6F1-03f, translation to Phase 5, CSV capacity/allocation to
Phase 6. No aggregation, metrics WS or executor implementation is introduced.
Runtime harness: N/A; typed declarations are not proof of a k6 execution.
Rollback only load modules/tests, additive load exports, the load guide section and
these notes; preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — typed graph composition (K6F1-03f)

Bind reviewed parameter contracts to structural node kinds additively; existing
modules stay unchanged. See [the composition guide](api/graph.md#typed-draft-and-ready-graph-composition-k6f1-03f).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Structural kinds retained with kind-typed `parameters` | Ready graphs must pass the reviewed execution topology, which only admits `authentication`, `http-request`, `response-validation` and `user-pool`; each kind gains optional (draft) or required (ready) parameters validated by its reviewed schema, without altering those modules. |
| Built-in reserved `response` output | Every `http-request` exposes exactly one `http-response` output, even without parameters; declared authentication/CSV outputs may not use the name. Checks consume only `http-response` through their existing `response` identity; authentication exposes declared extraction outputs only, never a raw response. |
| Exact-set reference reconciliation | Declared `node.references` equal references embedded in supported slots (URL/header/query values, text/JSON bodies, authentication request fields, checks `response`); order and duplicates ignored, exact comparison without normalization, dangling or undeclared references reject in draft and ready. Counting the checks `response` identity lets the reviewed topology enforce its precedence uniformly. |
| Slot/type compatibility, precedence only when ready | String outputs feed string consumers and count as JSON data; JSON outputs never feed string consumers; `http-response` feeds checks only. Producer existence, catalog membership and type match hold in drafts; connection-order precedence is enforceable only on the reviewed linear topology, so it is a ready-graph guarantee. |
| Draft/ready readiness split | Draft nodes may omit whole parameter objects and `load`; present payloads must be fully valid. Ready graphs require every parameter, the linear topology and a top-level global `load`. |

Declaration only: no runtime resolution, response-value validation, script
translation, executors, REST precedence, CSV ingestion, recorder or UI.
Runtime harness: N/A; composition validators are pure declarations. Rollback only
the composition modules/tests, additive exports, the composition guide section
and these notes; preserve reviewed contracts, parent tracking and unrelated
surfaces.

## Phase 1 — runs/health REST contract declarations (K6F1-04)

Declare strict version 1 runs REST request/response schemas, a pure idempotency
derivation and a hand-written OpenAPI 3.1 document without handlers or runtime.
See [the runs guide](api/runs.md).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Async lifecycle with idempotent start | `POST /api/runs` answers `202` + runId; an identical `Idempotency-Key` and payload replays `200` with the existing runId while an absent key always creates; stop answers `202`, unknown runId `404`, premature summary `409`. Dedupe is a pure derivation over caller-supplied records, never a store. |
| Exact five-status closed set | `pending`/`running`/`finished`/`failed`/`stopped`; `finished` means normal completion including threshold evaluation (only that final summary carries `thresholdsPassed`), `failed` is reserved for engine/infra errors. |
| Opaque compiled script with REST override | The payload carries an already compiled script string, never a graph, parsed k6 options or evaluated thresholds; REST `vus`/`durationMs` always override script-embedded options; `cpuMillis`/`memoryMiB` are required positive safe integers; attachments are opaque ids without byte upload. |
| Static bearer auth and explicit version | Every `/api/*` route requires `Authorization: Bearer <token>` (`401` otherwise) and all API bodies carry the literal `version: 1`; the public unversioned `/healthz` remains process-only and untouched. |

Declaration only: no handlers, servers, idempotency store, schedulers or threshold
evaluation; the cumulative final summary stays separate from the K6F1-05 windowed
WebSocket topic. Runtime harness: N/A; pure declarations add no process/network
boundary. Rollback only the runs-rest module/tests, additive index exports,
`api/runs.md`, `api/openapi.yaml` and these notes; preserve reviewed contracts,
parent tracking and unrelated surfaces.

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
