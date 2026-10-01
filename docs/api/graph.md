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
Forms, multipart/files, authentication, extraction, checks and load remain deferred.
