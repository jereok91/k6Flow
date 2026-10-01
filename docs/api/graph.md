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
