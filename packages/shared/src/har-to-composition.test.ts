import { describe, expect, it } from "vitest";
import { graphDraftCompositionSchema } from "./graph-composition";
import type { GraphDraftComposition } from "./graph-composition";
import { importHar, validateHar } from "./har-import";
import type { Har, HarImportedGraph, HarImportedNode } from "./har-import";
import { harGraphToComposition } from "./har-to-composition";
import { harGraphToComposition as publicHarGraphToComposition } from "./index";

const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

type ImportedParameters = HarImportedNode["parameters"];

interface RequestSpec {
  label?: string;
  parameters?: ImportedParameters;
  position?: { x: number; y: number };
  parentId?: string;
}

const request = (id: string, spec: RequestSpec = {}): HarImportedNode => {
  const node: HarImportedNode = {
    id,
    type: "http_request",
    label: spec.label ?? `GET /${id}`,
    position: spec.position ?? { x: 100, y: 100 },
    parameters: spec.parameters ?? { method: "GET", url: `https://api.example.com/${id}` },
  };
  if (spec.parentId !== undefined) node.parentId = spec.parentId;
  return node;
};

const group = (id: string, label = "Step 2: 2 requests"): HarImportedNode => ({
  id,
  type: "group",
  label,
  position: { x: 100, y: 200 },
  parameters: {},
});

interface EdgeSpec {
  from: string;
  to: string;
  waitSeconds?: number;
}

const graph = (nodes: HarImportedNode[], edges: EdgeSpec[] = []): HarImportedGraph => ({
  nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  edges,
  startNode: nodes[0]?.id,
});

const labels = (result: ReturnType<typeof harGraphToComposition>): string[] =>
  result.composition.nodes.map((node) => node.label ?? "");

// Parameters are typed per node kind; every converted node is an HTTP request.
const httpParameters = (node: GraphDraftComposition["nodes"][number] | undefined) =>
  node?.kind === "http-request" ? node.parameters : undefined;

// -----------------------------------------------------------------------------
// Structure: version, kinds, linear connections
// -----------------------------------------------------------------------------

describe("harGraphToComposition structure", () => {
  it("converts request nodes into a linear chain of http-request nodes", () => {
    const result = harGraphToComposition(graph([
      request("a", { parameters: { method: "GET", url: "https://api.example.com/v1/status" } }),
      request("b", { parameters: { method: "POST", url: "https://api.example.com/v1/login" } }),
      request("c", { parameters: { method: "GET", url: "https://api.example.com/v1/users" } }),
    ], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));

    expect(result.warnings).toEqual([]);
    expect(result.composition.version).toBe(1);
    expect(result.composition.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(result.composition.nodes.map((node) => node.kind))
      .toEqual(["http-request", "http-request", "http-request"]);
    // Imported graphs carry no producer references, so every node declares none.
    for (const node of result.composition.nodes) expect(node.references).toEqual([]);
    expect(result.composition.nodes[0].position).toEqual({ x: 100, y: 100 });
    expect(result.composition.connections).toEqual([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("keeps the imported position and omits a position that is not finite", () => {
    const result = harGraphToComposition(graph([
      request("a", { position: { x: 10, y: 20 } }),
      request("b", { position: { x: Number.NaN, y: 20 } }),
      request("c", { position: { x: 30, y: Number.POSITIVE_INFINITY } }),
    ], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));

    expect(result.composition.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(result.composition.nodes[1].position).toBeUndefined();
    expect(result.composition.nodes[2].position).toBeUndefined();
    expect(result.warnings).toEqual([
      'Dropped the position of "GET /b": expected finite coordinates',
      'Dropped the position of "GET /c": expected finite coordinates',
    ]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("returns an empty composition for an empty imported graph", () => {
    const result = harGraphToComposition({ nodes: {}, edges: [] });

    expect(result.composition).toEqual({ version: 1, nodes: [], connections: [] });
    expect(result.warnings).toEqual([]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------

describe("harGraphToComposition labels", () => {
  it("trims the imported label and falls back to METHOD /path when it is unusable", () => {
    const result = harGraphToComposition(graph([
      request("a", {
        label: "  Step 1: GET /v1/status  ",
        parameters: { method: "GET", url: "https://api.example.com/v1/status" },
      }),
      request("b", {
        label: "   ",
        parameters: { method: "POST", url: "https://api.example.com/v1/login?next=/home" },
      }),
      request("c", {
        label: "step ".repeat(40),
        parameters: { method: "DELETE", url: "https://api.example.com/v1/users/7" },
      }),
    ], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));

    expect(labels(result)).toEqual([
      "Step 1: GET /v1/status",
      "POST /v1/login",
      "DELETE /v1/users/7",
    ]);
    for (const label of labels(result)) expect(label.length).toBeLessThanOrEqual(120);
    expect(result.warnings).toEqual([]);
  });

  it("truncates an over-long fallback label to 120 characters", () => {
    const path = `/${"segment/".repeat(30)}`;
    const result = harGraphToComposition(graph([
      request("a", { label: "", parameters: { method: "GET", url: `https://api.example.com${path}` } }),
    ]));

    expect(result.composition.nodes[0].label).toHaveLength(120);
    expect(result.composition.nodes[0].label?.startsWith("GET /segment/")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Typed parameters
// -----------------------------------------------------------------------------

describe("harGraphToComposition parameters", () => {
  it("converts the flat method, url, headers and body into typed values", () => {
    const result = harGraphToComposition(graph([
      request("a", {
        label: "POST /v1/login",
        parameters: {
          method: "POST",
          url: "https://api.example.com/v1/login",
          headers: [
            { key: "X-Trace", value: "abc-123" },
            { key: "Accept", value: "application/json" },
          ],
          body: '{"user":"ana"}',
          contentType: "application/json; charset=utf-8",
        },
      }),
    ]));

    expect(result.warnings).toEqual([]);
    expect(result.composition.nodes[0].parameters).toEqual({
      method: "POST",
      url: { kind: "literal", value: "https://api.example.com/v1/login" },
      headers: [
        { name: "X-Trace", value: { kind: "literal", value: "abc-123" } },
        { name: "Accept", value: { kind: "literal", value: "application/json" } },
      ],
      body: { kind: "json", value: { kind: "literal", value: '{"user":"ana"}' } },
    });
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("omits headers and body that the request does not carry", () => {
    const result = harGraphToComposition(graph([
      request("a", { parameters: { method: "GET", url: "https://api.example.com/v1/status" } }),
    ]));

    expect(result.composition.nodes[0].parameters).toEqual({
      method: "GET",
      url: { kind: "literal", value: "https://api.example.com/v1/status" },
    });
  });

  it("maps the representable body content types to their typed kinds", () => {
    const cases: Array<[string, string]> = [
      ["application/json", "json"],
      ["application/vnd.api+json", "json"],
      ["application/xml", "xml"],
      ["text/xml; charset=utf-8", "xml"],
      ["application/x-www-form-urlencoded", "form"],
      ["text/plain", "text"],
    ];

    for (const [contentType, kind] of cases) {
      const result = harGraphToComposition(graph([
        request("a", {
          label: "POST /v1/data",
          parameters: { method: "POST", url: "https://api.example.com/v1/data", body: "payload", contentType },
        }),
      ]));

      expect(result.warnings).toEqual([]);
      expect(httpParameters(result.composition.nodes[0])?.body)
        .toEqual({ kind, value: { kind: "literal", value: "payload" } });
    }
  });

  it("warns about a body content type the typed schema cannot represent", () => {
    const payload = "------boundary\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n------boundary--";
    const result = harGraphToComposition(graph([
      request("a", {
        label: "POST /v1/upload",
        parameters: {
          method: "POST",
          url: "https://api.example.com/v1/upload",
          body: payload,
          contentType: "multipart/form-data; boundary=----boundary",
        },
      }),
    ]));

    expect(result.warnings).toEqual([
      'Content type "multipart/form-data" on "POST /v1/upload" cannot be represented by the typed body; the body was imported as text',
    ]);
    // The body is kept instead of being silently dropped.
    expect(httpParameters(result.composition.nodes[0])?.body)
      .toEqual({ kind: "text", value: { kind: "literal", value: payload } });
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("warns when a body has no content type and guesses its kind", () => {
    const result = harGraphToComposition(graph([
      request("a", {
        label: "POST /v1/data",
        parameters: { method: "POST", url: "https://api.example.com/v1/data", body: '{"a":1}' },
      }),
    ]));

    expect(result.warnings).toEqual([
      'No content type on "POST /v1/data": the body was imported as json',
    ]);
    expect(httpParameters(result.composition.nodes[0])?.body)
      .toEqual({ kind: "json", value: { kind: "literal", value: '{"a":1}' } });
  });

  it("warns about dropped headers, invalid methods and content types without a body", () => {
    const result = harGraphToComposition(graph([
      request("a", {
        label: "POST /v1/data",
        parameters: {
          method: "GE T",
          url: "https://api.example.com/v1/data",
          headers: [{ key: "  ", value: "ignored" }, { key: "Accept", value: "application/json" }],
          contentType: "application/json",
        },
      }),
    ]));

    expect(result.warnings).toEqual([
      'Invalid HTTP method "GE T" on "POST /v1/data": replaced with GET',
      'Dropped a header with an empty name on "POST /v1/data"',
      'Dropped content type "application/json" on "POST /v1/data": the request has no body',
    ]);
    expect(result.composition.nodes[0].parameters).toEqual({
      method: "GET",
      url: { kind: "literal", value: "https://api.example.com/v1/data" },
      headers: [{ name: "Accept", value: { kind: "literal", value: "application/json" } }],
    });
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Steps and groups (D5 rule 4)
// -----------------------------------------------------------------------------

describe("harGraphToComposition steps", () => {
  it("flattens a step group into the chain and keeps the import order", () => {
    const result = harGraphToComposition(graph([
      request("a", { parameters: { method: "GET", url: "https://api.example.com/v1/start" } }),
      group("g1"),
      request("b", { parentId: "g1", parameters: { method: "GET", url: "https://api.example.com/v1/b" } }),
      request("c", { parentId: "g1", parameters: { method: "GET", url: "https://api.example.com/v1/c" } }),
      request("d", { parameters: { method: "GET", url: "https://api.example.com/v1/d" } }),
    ], [{ from: "a", to: "g1", waitSeconds: 2.5 }, { from: "g1", to: "d", waitSeconds: 4 }]));

    expect(result.warnings).toEqual([]);
    expect(result.composition.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.composition.connections).toEqual([
      { source: "a", target: "b", waitSeconds: 2.5 },
      { source: "b", target: "c" },
      { source: "c", target: "d", waitSeconds: 4 },
    ]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("drops a node whose type is neither a request nor a step and warns", () => {
    const result = harGraphToComposition(graph([
      request("a"),
      { id: "x", type: "comment", label: "Note", position: { x: 0, y: 0 }, parameters: {} },
      request("c"),
    ], [{ from: "a", to: "x" }, { from: "x", to: "c" }]));

    expect(result.composition.nodes.map((node) => node.id)).toEqual(["a", "c"]);
    expect(result.composition.connections).toEqual([{ source: "a", target: "c" }]);
    expect(result.warnings).toEqual([
      'Dropped node "Note" of unsupported type "comment": it is not a graph node',
    ]);
  });

  it("chains requests the imported edges never reached instead of losing them", () => {
    const result = harGraphToComposition({
      nodes: {
        a: request("a"),
        b: request("b", { parameters: { method: "GET", url: "https://api.example.com/orphan" } }),
        c: request("c"),
      },
      edges: [{ from: "a", to: "c" }],
      startNode: "a",
    });

    expect(result.composition.nodes.map((node) => node.id)).toEqual(["a", "c", "b"]);
    expect(result.composition.connections).toEqual([
      { source: "a", target: "c" },
      { source: "c", target: "b" },
    ]);
    expect(result.warnings).toEqual([
      'Node "GET /b" was not reachable from the imported start node: appended in import order',
    ]);
  });
});

// -----------------------------------------------------------------------------
// waitSeconds (D5 rule 5)
// -----------------------------------------------------------------------------

describe("harGraphToComposition waits", () => {
  it("carries the step-entry wait onto the first request of the step only", () => {
    const result = harGraphToComposition(graph([
      group("g1"),
      request("a", { parentId: "g1" }),
      request("b", { parentId: "g1" }),
      group("g2"),
      request("c", { parentId: "g2" }),
      request("d", { parentId: "g2" }),
    ], [{ from: "g1", to: "g2", waitSeconds: 7.25 }]));

    expect(result.composition.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.composition.connections).toEqual([
      { source: "a", target: "b" },
      { source: "b", target: "c", waitSeconds: 7.25 },
      { source: "c", target: "d" },
    ]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("keeps the boundary waits 0 and 3600 seconds", () => {
    const result = harGraphToComposition(graph([
      request("a"), request("b"), request("c"),
    ], [{ from: "a", to: "b", waitSeconds: 0 }, { from: "b", to: "c", waitSeconds: 3600 }]));

    expect(result.composition.connections).toEqual([
      { source: "a", target: "b", waitSeconds: 0 },
      { source: "b", target: "c", waitSeconds: 3600 },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("drops waits that are not a finite number inside 0..3600", () => {
    const result = harGraphToComposition(graph([
      request("a"), request("b"), request("c"), request("d"),
    ], [
      { from: "a", to: "b", waitSeconds: -1 },
      { from: "b", to: "c", waitSeconds: 3600.5 },
      { from: "c", to: "d", waitSeconds: Number.NaN },
    ]));

    expect(result.composition.connections).toEqual([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
    ]);
    expect(result.warnings).toEqual([
      'Dropped wait of -1 seconds on the connection into "GET /b": expected a finite value between 0 and 3600',
      'Dropped wait of 3600.5 seconds on the connection into "GET /c": expected a finite value between 0 and 3600',
      'Dropped wait of NaN seconds on the connection into "GET /d": expected a finite value between 0 and 3600',
    ]);
    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Acceptance: the reference HAR from docs/examploHar.har
// -----------------------------------------------------------------------------

// The reference HAR is the user's own export and is not versioned, so this
// acceptance block only runs where the file exists instead of failing CI with
// ENOENT.
const hasReferenceHar = (() => {
  try {
    readFileSync("docs/examploHar.har", "utf8");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasReferenceHar)("harGraphToComposition acceptance on docs/examploHar.har", () => {
  const reference = (): Har => {
    const parsed: unknown = JSON.parse(readFileSync("docs/examploHar.har", "utf8"));
    expect(validateHar(parsed)).toBe(true);
    return parsed as Har;
  };

  it("turns the imported reference graph into an openable composition", () => {
    const imported = importHar(reference(), { name: "Reference", excludeStatic: false });
    const requestNodes = Object.values(imported.graph.nodes).filter((node) => node.type === "http_request");
    expect(requestNodes).toHaveLength(16);
    expect(imported.stats.steps).toBe(5);

    const result = harGraphToComposition(imported.graph);

    expect(graphDraftCompositionSchema.safeParse(result.composition).success).toBe(true);
    expect(result.composition.version).toBe(1);
    expect(result.composition.nodes).toHaveLength(requestNodes.length);
    expect(result.composition.nodes.every((node) => node.kind === "http-request")).toBe(true);

    // One connection per consecutive request pair: this is what opens the editor.
    const pairs = requestNodes.slice(1).map((node, index) => [requestNodes[index].id, node.id]);
    expect(result.composition.connections).toHaveLength(requestNodes.length - 1);
    expect(result.composition.connections.map((connection) => [connection.source, connection.target])).toEqual(pairs);

    // Only the four step boundaries carry a wait, all inside the contract range.
    const carrying = result.composition.connections.filter((connection) => connection.waitSeconds !== undefined);
    expect(carrying).toHaveLength(imported.stats.steps - 1);
    for (const connection of carrying) {
      expect(connection.waitSeconds).toBeGreaterThanOrEqual(0);
      expect(connection.waitSeconds).toBeLessThanOrEqual(3600);
    }
    expect(carrying.map((connection) => connection.waitSeconds)).toEqual([1.699, 3.042, 6.715, 2.473]);
    expect(result.warnings).toEqual([]);

    // Every request of the reference file stays present with a usable label.
    const urls = result.composition.nodes.map((node) => httpParameters(node)?.url);
    expect(urls).toEqual(requestNodes.map((node) => ({ kind: "literal", value: node.parameters.url })));
    for (const node of result.composition.nodes) {
      expect((node.label ?? "").trim().length).toBeGreaterThan(0);
      expect((node.label ?? "").length).toBeLessThanOrEqual(120);
    }
  });
});

describe("harGraphToComposition public surface", () => {
  it("is re-exported from the package entry point", () => {
    expect(publicHarGraphToComposition).toBe(harGraphToComposition);
  });
});
