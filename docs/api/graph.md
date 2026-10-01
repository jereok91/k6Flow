# Graph structure and execution topology (version 1)

These shared validators cover storage structure and traversal only. Passing
`graphExecutionTopologySchema` **does not mean a graph is execution-ready**.
Node parameters, global load configuration and supported producer outputs remain
K6F1-03 contracts. There is no runtime, translator or template syntax here.

## Choose the validation boundary

| Export | Guarantees |
|--------|------------|
| `graphDraftStructureSchema` / `GraphDraftStructure` | Strict versioned shape, unique node IDs, existing connection endpoints and reference producers, no duplicate directed connections. Empty and disconnected drafts are allowed. |
| `graphExecutionTopologySchema` / `GraphExecutionTopology` | All draft guarantees plus one nonempty connected linear chain and references to earlier producers in that chain. A single node with no references is valid topology. |

The inferred types have the same shape; topology validation adds runtime rules,
not an execution-readiness brand. Use `safeParse` or `parse` at the relevant
boundary. Validation preserves input array order; it does not reorder the graph.

## Structural shape

```ts
const draft = {
  version: 1,
  nodes: [
    { id: "request", kind: "http-request", references: [] },
    { id: "check", kind: "response-validation",
      references: [{ producerNodeId: "request", output: "opaque-result" }] },
  ],
  connections: [{ source: "request", target: "check" }],
};
```

Every field shown is required; unknown fields fail at every object level.
The four node kinds are `authentication`, `http-request`, `response-validation`
and `user-pool`. IDs, endpoints, producer IDs and output strings must be nonblank
strings; they are compared exactly, without trimming, coercion or defaults.
`output` is an opaque structural name, **not a validated supported output**;
`opaque-result` in the example is not an extraction contract or template.

## Topology rules and draft retention

Connections, not node or connection array order, determine producer precedence.
Execution topology rejects forks, merges, cycles, self-loops, disconnected
components, later-producer references and self-references. Iterative traversal
uses maps/sets, with linear work in nodes, connections and references.

Draft validation deliberately does not check precedence or linearity: references
to existing self/later/disconnected producers and unfinished connections can be
retained while editing. Missing producers and dangling endpoints still fail;
omit an unfinished reference/connection rather than store a missing identity.
Repeated producer/output references are permitted; binding and output semantics
are deferred. Validation issues have stable paths/order for identical input.

## Standalone HTTP parameters (K6F1-03a)

`httpParametersSchema` / `HttpParameters` validate independent parameters, not
nodes or executable graphs. Existing structural graph schemas remain unchanged.

```ts
const parameters = {
  method: "GET",
  url: { kind: "literal", value: "https://example.test/${path}" },
  headers: [{ name: "Authorization", value: { kind: "reference",
    reference: { producerNodeId: "auth", output: "token" } } }],
  query: [{ name: "q", value: { kind: "literal", value: "search" } }],
  body: { kind: "none" },
};
```

| Field / export | Wire contract |
|----------------|---------------|
| `method` / `httpMethodSchema` | Required nonempty HTTP token string; extension methods and original case retained. No method/body compatibility rule. |
| `url` | Required `stringParameterValueSchema`: whole string literal or reference. No URL parsing, allowlist or SSRF guarantee. |
| `headers`, `query` / `httpNamedValueSchema` | Optional ordered arrays of strict `{ name, value }` entries; nonempty string names, whole string values. Duplicates retained; no name normalization, header syntax or encoding policy. |
| `body` / `httpBodySchema` | Optional strict `{ kind: "none" }`, `{ kind: "text", value: <string parameter> }` or `{ kind: "json", value: <JSON parameter> }`. Omission remains omission, not a default. |

A parameter is exactly `{ kind: "literal", value: ... }` or
`{ kind: "reference", reference: { producerNodeId, output } }`.
`producerOutputReferenceSchema` reuses the graph's exact nonblank identity shape.
Unknown fields fail in all contract objects; values are not coerced or trimmed.
The consumer defines the expected kind: URL/header/query/text require a string;
JSON requires `JsonValue`. References carry identities, not a claimed output type.

`jsonParameterValueSchema` accepts a whole JSON literal or whole JSON reference.
`jsonValueSchema` accepts null, booleans, finite numbers, strings, dense arrays
and plain data objects (including null-prototype records). Cycles, undefined,
functions, accessors, symbol/hidden properties and native/class instances fail.
JSON object keys are data, not strict contract fields. Literal JSON objects that
look like reference tags remain ordinary data, never nested dynamic bindings.

Every reference replaces the **entire consuming value**. Literal `${path}`,
`{{token}}` and `Bearer ${token}` remain exact text. There are no segments,
selectors, templates, scripts or secret bindings; composing URL paths or adding
`Bearer ` to a referenced token is unavailable. A producer would need to supply
the whole required value; supported producer contracts are not established here.

K6F1-03f must reconcile parameter-embedded references with `node.references` and
validate producer existence, precedence, supported outputs and type compatibility.
Standalone validation proves none of those. No HTTP execution, serialization,
query/header encoding, content-type insertion or transport behavior is implemented.
Forms, multipart/files and load remain deferred. Authentication/extraction
now have the independent validation boundary below, not a runtime implementation.

## Standalone target authentication (K6F1-03b)

`authParametersSchema` / `AuthParameters` describe a scenario's external-target
login, **not K6Flow user authentication**. Only tagged HTTP login is supported.
The request reuses `HttpParameters` unchanged, including whole literal/reference
values. This is independently usable validation, not graph execution readiness.

```ts
const auth = {
  method: { kind: "http", request: {
    method: "POST",
    url: { kind: "literal", value: "https://example.test/login" },
    body: { kind: "none" },
  } },
  outputs: [
    { name: "token", required: true, expectedType: "string",
      selector: { kind: "json-path", path: ["session", "token"] } },
    { name: "profile", required: true, expectedType: "json",
      selector: { kind: "json-path", path: ["users", 0, "profile"] } },
    { name: "trace", required: true, expectedType: "string",
      selector: { kind: "header", name: "X-Trace" } },
    { name: "session", required: true, expectedType: "string",
      selector: { kind: "cookie", name: "session_id" } },
  ],
  onOutputFailure: "stop-current-vu-iteration",
};
```

| Field / export | Wire contract |
|----------------|---------------|
| `method` / `authMethodSchema` | Strict `{ kind: "http", request: <HTTP parameters> }`; future variants require explicit contracts. Basic Auth/OAuth2 are not supported. |
| `outputs` / `authOutputSchema` | Nonempty ordered array; exact unique nonblank `name` identities reuse the graph reference's `output` schema. No trimming or normalization. Every output requires literal `required: true`. |
| `selector` / `authOutputSelectorSchema` | Strict `json-path` with `path`, or `header`/`cookie` with `name`. Named header/cookie selectors require HTTP token syntax and preserve case. This does not tighten existing request-header validation. |
| `path` / `authJsonPathSegmentSchema` | Array of exact object-key strings or nonnegative safe integer array indices. Empty path selects the entire JSON value; empty string selects an empty key. String `"0"` is an object key, number `0` an array index. |
| `expectedType` / `authOutputTypeSchema` | Required `string` or `json` consumer category. Header/cookie outputs require `string`. JSON-path outputs may declare either; `json` means the existing finite `JsonValue` domain, including strings and null, not JSON serialization text. |
| `onOutputFailure` / `authOutputFailurePolicySchema` | Required literal `stop-current-vu-iteration`: missing required output or wrong type ends only this VU iteration; other VUs continue. This validator stores policy and does not perform extraction or stop anything. |

All contract objects reject unknown fields; no coercion, defaults or input
mutation occurs. JSON-path strings are literal keys: `$.token`, `x()` or
`{{token}}` inside a segment are not evaluated. There is no JavaScript,
JSONPath-expression, traversal operator, template or host-filesystem access.
Prototype-sensitive keys such as `__proto__` are ordinary JSON keys; a future
resolver must access only own JSON data properties, never inherited properties,
getters or host prototypes. Numeric segments address arrays only, not object keys.

Expected types establish declarations for K6F1-03f compatibility checks: string
outputs can supply string consumers and are JSON data; a general JSON output does
not guarantee a string consumer. Actual response values are not validated here.
Graph binding, producer precedence and reference reconciliation remain K6F1-03f.

Optional outputs are unsupported until their missing-value behavior is decided.
Repeated response-header selection, case matching, cookie parsing and ambiguous
same-name cookies require future runtime decisions; no first/last match or cookie
jar is assumed. Invalid response JSON and transport/login status handling also
remain undefined. No JWT decoding/minting, secret binding, Bearer-prefix
concatenation, cookie persistence or runner/resolver is introduced.

## Standalone response checks (K6F1-03c)

`checkParametersSchema` / `CheckParameters` validate version 1 declarations only.
They neither resolve a response nor run k6 `check()` or iteration control flow.

```ts
const checks = {
  version: 1,
  response: { producerNodeId: "request", output: "response" },
  checks: [
    { name: "status OK", kind: "status", operator: "eq", expected: 200 },
    { name: "fast", kind: "duration-ms", operator: "lt", expected: 500 },
    { name: "text", kind: "body-text",
      predicate: { operator: "contains-literal", expected: "ready" } },
    { name: "trace", kind: "header", header: "X-Trace",
      predicate: { operator: "exists" } },
    { name: "user", kind: "json-path", path: ["users", 0, "id"],
      predicate: { operator: "deep-eq", expected: 7 } },
  ],
  onCheckFailure: "record-failure-and-continue",
};
```

| Boundary | Contract |
|----------|----------|
| `response` | Required strict producer/output identity; no implicit latest response. `response` above is illustrative, not a declared supported producer output. |
| `checks` / `responseCheckSchema` | Nonempty ordered array of independent checks with exact unique nonblank names; unknown contract fields fail. |
| `status`, `duration-ms` | Required finite numeric `expected`; `checkNumericOperatorSchema` permits `eq`, `ne`, `lt`, `lte`, `gt`, `gte`. Duration unit is milliseconds. No coercion or status-range policy. |
| `body-text`, `header` | Strict `predicate`: `exists` without expected data, or `eq` / `ne` / `contains-literal` with string `expected` (literal equality, inequality or containment). Header requires an exact HTTP-token `header` name, preserving case. |
| `json-path` | Structured `path`; predicate is `exists` without expected data or `deep-eq` with literal `JsonValue`. No text parsing of expected JSON. |
| `onCheckFailure` / `checkFailurePolicySchema` | Required literal `record-failure-and-continue`; no configurable abort policy. |

`checkJsonPathSegmentSchema` reuses the reviewed auth path definition unchanged:
strings select exact object keys, nonnegative safe integers select array indices,
and an empty path selects the JSON root. String `"0"` is not numeric index `0`.
Prototype-sensitive keys are data; future resolution must use own JSON properties.
Reference-looking equality objects remain literal data. Strings containing regex,
expressions or interpolation syntax remain literal strings/keys, never executable.
There are no regex predicates, callbacks, scripts, secret bindings or templates.

The declared execution intent is one independent result per named check. A failed
comparison, absent selected field or incompatible actual type records failure and
continues the iteration, without suppressing later checks. Existence tests presence,
not truthiness: present JSON null/false/zero are data. Text/header checks require
strings, numeric checks numbers, and JSON checks valid JSON data; deep equality is
structural JSON equality, not reference identity or serialized-text equality.
This validator inspects declarations only, not actual responses or check results.

Producer output support, graph precedence/reference reconciliation and response
compatibility belong to K6F1-03f. Header case matching/repeated headers, ambiguous
responses, runtime coercion, invalid response JSON and transport handling remain
unresolved; no first/last selection, conversion or transport policy is supplied.

## Standalone CSV pool declarations (K6F1-03d)

`csvPoolParametersSchema` / `CsvPoolParameters` validate version 1 declarations
only. They do not load CSV, resolve attachments, check capacity or assign rows.
Existing graph schemas are unchanged; `user-pool` is still a structural node kind.

```ts
const pool = {
  version: 1,
  attachment: { id: "dummy-csv-attachment" },
  allocation: "csv-order-distinct-row-per-vu",
  onInsufficientCapacity: "reject-before-execution",
  outputs: [
    { header: "dummy_label", name: "label", expectedType: "string", required: true },
  ],
};
```

| Field / export | Declaration contract |
|----------------|----------------------|
| `attachment` / `csvPoolAttachmentSchema` | Strict `{ id }` external attachment identity; nonblank exact string, opaque and unresolved. No inline CSV, URL, filesystem-path or secret alternative fields. Identity syntax itself is not a resolver/security guarantee. |
| `allocation` / `csvPoolAllocationSchema` | Required literal `csv-order-distinct-row-per-vu`: distinct rows assigned to VUs in stable CSV order; the same VU reuses its assigned row across iterations. No sharing, random assignment or per-iteration rotation. |
| `onInsufficientCapacity` / `csvPoolCapacityPolicySchema` | Required literal `reject-before-execution`; a future consumer must reject insufficient distinct-row capacity before starting execution, never wrap or share rows. Validation does not evaluate capacity or establish readiness. |
| `outputs` / `csvPoolOutputSchema` | Nonempty ordered array of strict `{ header, name, expectedType, required }` mappings. Named headers are nonblank exact strings; output names reuse structural output identity and must be unique. Every mapping requires `expectedType: "string"` and `required: true`. |

All fields are required; unknown fields fail at every object level. Validation
preserves strings and mapping order without coercion, trimming, defaults or input
mutation. A future consumer must expose the selected cell as its original string,
without conversion or trimming. There is no optional-output or positional-column
policy. Distinct output names may map the same named source header; that does not
decide how duplicate headers in an actual CSV file are handled.

Phase 6 owns SharedArray CSV loading, required-column presence validation,
capacity validation and assignment. VU identity/assignment mechanics, CSV dialect,
encoding, duplicate actual CSV headers and malformed-row handling remain deferred.
Required headers are declared here, not checked against actual attachment data.
Consumers must not log CSV contents or credentials and must minimize retention;
this schema implements neither logging controls nor retention enforcement.
K6F1-03f owns producer output catalogs, type compatibility, embedded-reference
reconciliation and execution readiness. Passing this standalone schema proves
none of those properties and does not authorize an actual run.

## Standalone global load and thresholds (K6F1-03e)

`loadParametersSchema` / `LoadParameters` validate strict version 1 declarations:
**one global profile**, not per-node overrides or concurrent scenarios. Existing
structural graph schemas remain unchanged; this does not prove execution readiness.

```ts
const load = {
  version: 1,
  profile: { kind: "constant-vus", vus: 2, durationMs: 1000 },
  thresholds: [
    { metric: "http_req_duration", aggregator: "p95", unit: "ms",
      operator: "lt", expected: 500.5 },
    { metric: "http_req_failed", aggregator: "rate", unit: "fraction",
      operator: "lte", expected: 0.01 },
  ],
  thresholdPolicy: "final-pass-fail",
};
// Alternative profile; stages retain this order, including ramp-down to zero.
const staged = { kind: "staged-vus", startVus: 0,
  stages: [{ durationMs: 1000, targetVus: 2 }, { durationMs: 500, targetVus: 0 }] };
```

| Field / export | Declaration contract |
|----------------|----------------------|
| `profile` / `loadProfileSchema` | Tagged `constant-vus` with positive safe-integer `vus` and `durationMs`, or `staged-vus` with explicit nonnegative safe-integer `startVus` and nonempty ordered `stages`. |
| Stage / `loadStageSchema` | Strict `{ durationMs, targetVus }`; positive safe-integer milliseconds and nonnegative safe-integer VUs. Across startup and targets, at least one load value must be positive; all-zero profiles fail. Startup and ramp-down targets may be zero. |
| `thresholds` / `loadThresholdSchema` | Required ordered array, possibly empty. Empty means no threshold criteria, not missing defaults. Repeated metrics and identical declarations are allowed. |
| `http_req_duration` | Only Trend aggregators `avg`, `p90`, `p95`, `p99`; required `unit: "ms"`, finite `expected >= 0`. Fractional milliseconds are allowed; no conversion. |
| `http_req_failed` | Only `aggregator: "rate"`; required `unit: "fraction"`, finite `expected` in inclusive `[0, 1]`, not percent. |
| `operator` | Six numeric comparisons: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, reusing `checkNumericOperatorSchema`. No DSL strings or predicate evaluation. |
| `thresholdPolicy` / `loadThresholdPolicySchema` | Required literal `final-pass-fail`: assess overall threshold pass/fail at execution end. No early abort or abort delays. |

Every shown field is required; all contract object levels reject unknown fields.
Validation preserves data/order without mutation, coercion, normalization or defaults.
`LoadStage`, `LoadProfile`, `LoadThreshold`, `LoadThresholdPolicy` and `LoadParameters`
are public schema-inferred types; metric/aggregator/unit pairings are typed together.
No IDs or labels are needed. Iteration/arrival-rate executors, custom metrics, tag
filters, checks-success metrics, arbitrary percentiles, callbacks and JavaScript
are unsupported. Response checks retain their separate fixed
`record-failure-and-continue` policy; thresholds do not change that declaration.

No statistics aggregation, predicate execution, script translation or k6 run occurs.
Typed metric configuration is not evidence that k6 executed. K6F1-03f owns graph
composition, producer/reference compatibility and readiness; K6F1-04 owns REST/global
load precedence and status mapping. Phase 5 owns translation, Phase 6 CSV capacity
and row allocation. Engine-specific duration representability, graceful-stop and
startup-delay settings remain undecided, not silently defaulted or bounded here.

## Typed draft and ready graph composition (K6F1-03f)

`graphDraftCompositionSchema` / `GraphDraftComposition` and
`graphReadyCompositionSchema` / `GraphReadyComposition` bind the reviewed
parameter contracts to structural node kinds. Declaration and validation only:
no runtime resolution, response-value validation, script translation, executors,
REST precedence, CSV ingestion, recorder or UI behavior is introduced.

| Kind | `parameters` | Exposed outputs |
|------|--------------|-----------------|
| `authentication` | `authParametersSchema` | Declared extraction outputs only, typed `string`/`json` as declared. No raw auth response. |
| `http-request` | `httpParametersSchema` | Exactly one built-in output `response` of type `http-response`, exposed even while draft parameters are omitted. |
| `response-validation` | `checkParametersSchema` | None; it consumes but never produces. |
| `user-pool` | `csvPoolParametersSchema` | Declared CSV outputs, always type `string`. |

The output name `response` is reserved: declared authentication or CSV outputs
named `response` reject in both draft and ready graphs.

| Export | Guarantees |
|--------|------------|
| `graphDraftCompositionSchema` | All structural draft guarantees plus kind-typed optional `parameters` (present payloads must be fully valid; invalid partial payloads reject, never retained), optional valid `load`, exact reference reconciliation and catalog/type compatibility. Producer precedence is not enforceable while editing and is not checked. |
| `graphReadyCompositionSchema` | All draft guarantees plus the reviewed linear execution topology, required valid `parameters` on every node, earlier-producer precedence and a required top-level `load` (`loadParametersSchema`). |

Reference reconciliation: declared `node.references` must equal exactly the set
of references embedded in supported parameter slots — HTTP URL/header/query
values, text and JSON bodies, authentication request fields, and the checks
`response` identity. Order and duplicates are ignored; identities are compared
exactly, without normalization. Dangling declared or undeclared embedded
references reject; reference-shaped literal JSON remains data, never a binding.

Compatibility: the producer must exist, expose the referenced output in its
catalog and, in ready graphs, rank earlier by connection order via the reviewed
topology. String outputs supply string consumers and count as JSON data; JSON
outputs supply JSON consumers but never string consumers; `http-response`
outputs feed the response-validation `response` consumer only, and nothing else
supplies that slot. References are inspected only in supported slots.

Neither schema validates actual response values, extraction, CSV data or load
execution; passing ready composition is declaration-level readiness, not a run.
