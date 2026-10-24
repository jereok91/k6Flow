import { describe, expect, it } from "vitest";
import { graphDraftCompositionSchema } from "./graph-composition";
import type { GraphDraftComposition } from "./graph-composition";
import { importHar, validateHar } from "./har-import";
import type { Har, HarImportedGraph, HarImportedNode } from "./har-import";
import { harGraphToComposition } from "./har-to-composition";
import { applyVariableSuggestions, suggestHarVariables } from "./har-variables";
import type { HarVariableSuggestion } from "./har-variables";
import { isValidVariableName } from "./variables";

const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

interface RequestSpec {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
}

const request = (id: string, spec: RequestSpec = {}): HarImportedNode => {
  const parameters: HarImportedNode["parameters"] = {
    method: spec.method ?? "GET",
    url: spec.url ?? `https://api.example.com/${id}`,
  };
  if (spec.headers !== undefined) {
    parameters.headers = Object.entries(spec.headers).map(([key, value]) => ({ key, value }));
  }
  if (spec.body !== undefined) parameters.body = spec.body;
  if (spec.contentType !== undefined) parameters.contentType = spec.contentType;
  return {
    id,
    type: "http_request",
    label: `${parameters.method} /${id}`,
    position: { x: 100, y: 100 },
    parameters,
  };
};

const graph = (nodes: HarImportedNode[]): HarImportedGraph => ({
  nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
  startNode: nodes[0]?.id,
});

const of = (
  suggestions: readonly HarVariableSuggestion[],
  kind: HarVariableSuggestion["kind"],
): HarVariableSuggestion[] => suggestions.filter((suggestion) => suggestion.kind === kind);

const named = (
  suggestions: readonly HarVariableSuggestion[],
  name: string,
): HarVariableSuggestion | undefined => suggestions.find((suggestion) => suggestion.name === name);

// -----------------------------------------------------------------------------
// Rule 1: host
// -----------------------------------------------------------------------------

describe("suggestHarVariables - host", () => {
  it("suggests baseUrl when every request shares one origin", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1/status" }),
      request("b", { url: "https://api.example.com/v1/login" }),
    ]));

    expect(suggestions).toEqual([{
      name: "baseUrl",
      value: "https://api.example.com",
      secret: false,
      kind: "host",
      occurrences: 2,
      reasonCode: "single-origin",
      detail: "All 2 imported requests use the origin https://api.example.com",
    }]);
  });

  it("numbers one variable per origin in first-appearance order", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1/status" }),
      request("b", { url: "https://backend.example.com/v1/login" }),
      request("c", { url: "https://api.example.com/v1/users" }),
    ]));

    expect(of(suggestions, "host")).toEqual([
      {
        name: "baseUrl1",
        value: "https://api.example.com",
        secret: false,
        kind: "host",
        occurrences: 2,
        reasonCode: "repeated-origin",
        detail: "Origin https://api.example.com is used by 2 imported requests (origin 1 of 2)",
      },
      {
        name: "baseUrl2",
        value: "https://backend.example.com",
        secret: false,
        kind: "host",
        occurrences: 1,
        reasonCode: "repeated-origin",
        detail: "Origin https://backend.example.com is used by 1 imported request (origin 2 of 2)",
      },
    ]);
  });

  it("suggests no host when no url can be parsed", () => {
    expect(suggestHarVariables(graph([request("a", { url: "not a url" })]))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Rule 2: authorization
// -----------------------------------------------------------------------------

describe("suggestHarVariables - authorization", () => {
  it("suggests one authToken when the value is shared by several requests", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { authorization: "Bearer abc123" } }),
      request("b", { url: "https://other.example.com/b", headers: { Authorization: "Bearer abc123" } }),
    ]));

    expect(of(suggestions, "authorization")).toEqual([{
      name: "authToken",
      value: "Bearer abc123",
      secret: true,
      kind: "authorization",
      occurrences: 2,
      reasonCode: "shared-authorization",
      detail: "Authorization value is shared by 2 imported requests",
    }]);
  });

  it("still suggests an authorization value seen only once", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { authorization: "Bearer onlyonce" } }),
    ]));

    expect(of(suggestions, "authorization")).toEqual([{
      name: "authToken",
      value: "Bearer onlyonce",
      secret: true,
      kind: "authorization",
      occurrences: 1,
      reasonCode: "single-authorization",
      detail: "Authorization value appears once: replacing it keeps the credential out of the graph",
    }]);
  });

  it("suggests nothing when every authorization value is different", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { authorization: "Bearer one" } }),
      request("b", { headers: { authorization: "Bearer two" } }),
      request("c", { headers: { authorization: "Bearer three" } }),
    ]));

    // Per-request tokens cannot share one variable, so no auth variable is invented.
    expect(of(suggestions, "authorization")).toEqual([]);
  });

  it("keeps the repeated value and drops the per-request singletons", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { authorization: "Bearer shared" } }),
      request("b", { headers: { authorization: "Bearer shared" } }),
      request("c", { headers: { authorization: "Bearer transient" } }),
    ]));

    expect(of(suggestions, "authorization").map((suggestion) => suggestion.value))
      .toEqual(["Bearer shared"]);
  });
});

// -----------------------------------------------------------------------------
// Rule 3: cookies
// -----------------------------------------------------------------------------

describe("suggestHarVariables - cookie", () => {
  it("splits one cookie header into one suggestion per cookie", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { cookie: "session=abc123; theme=dark" } }),
    ]));

    expect(of(suggestions, "cookie")).toEqual([
      {
        name: "cookie_session",
        value: "abc123",
        secret: true,
        kind: "cookie",
        occurrences: 1,
        reasonCode: "cookie-value",
        detail: 'Cookie "session" carries the same value in 1 imported request',
      },
      {
        name: "cookie_theme",
        value: "dark",
        secret: true,
        kind: "cookie",
        occurrences: 1,
        reasonCode: "cookie-value",
        detail: 'Cookie "theme" carries the same value in 1 imported request',
      },
    ]);
  });

  it("counts repeated cookie values and sanitises the variable name", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { cookie: "XSRF-TOKEN=abc123; __cf[bm]=xyz" } }),
      request("b", { headers: { cookie: "XSRF-TOKEN=abc123" } }),
    ]));

    expect(named(suggestions, "cookie_XSRF-TOKEN")).toEqual({
      name: "cookie_XSRF-TOKEN",
      value: "abc123",
      secret: true,
      kind: "cookie",
      occurrences: 2,
      reasonCode: "cookie-value",
      detail: 'Cookie "XSRF-TOKEN" carries the same value in 2 imported requests',
    });
    expect(named(suggestions, "cookie___cf_bm_")).toMatchObject({ value: "xyz", occurrences: 1 });
  });

  it("skips a cookie name whose value changes between requests", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { cookie: "session=first; theme=dark" } }),
      request("b", { headers: { cookie: "session=second" } }),
    ]));

    expect(of(suggestions, "cookie").map((suggestion) => suggestion.name))
      .toEqual(["cookie_theme"]);
  });

  it("ignores blank pairs and pairs without a value", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { cookie: " ; flag; empty= ; ok=1; " } }),
    ]));

    expect(of(suggestions, "cookie").map((suggestion) => suggestion.name))
      .toEqual(["cookie_ok"]);
  });
});

// -----------------------------------------------------------------------------
// Rule 4: API keys in headers
// -----------------------------------------------------------------------------

describe("suggestHarVariables - api key headers", () => {
  it("suggests one variable per recognised api key header", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { "X-API-Key": "key-123456", apikey: "plain-123456", "X-Auth-Token": "token-123456" } }),
    ]));

    expect(of(suggestions, "api-key")).toEqual([
      {
        name: "x-api-key",
        value: "key-123456",
        secret: true,
        kind: "api-key",
        occurrences: 1,
        reasonCode: "api-key-header",
        detail: 'Header "x-api-key" carries the same value in 1 imported request',
      },
      {
        name: "apikey",
        value: "plain-123456",
        secret: true,
        kind: "api-key",
        occurrences: 1,
        reasonCode: "api-key-header",
        detail: 'Header "apikey" carries the same value in 1 imported request',
      },
      {
        name: "x-auth-token",
        value: "token-123456",
        secret: true,
        kind: "api-key",
        occurrences: 1,
        reasonCode: "api-key-header",
        detail: 'Header "x-auth-token" carries the same value in 1 imported request',
      },
    ]);
  });

  it("skips an api key header whose value changes between requests", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { "x-api-key": "key-one" } }),
      request("b", { headers: { "x-api-key": "key-two" } }),
    ]));

    expect(of(suggestions, "api-key")).toEqual([]);
  });

  it("ignores unrelated headers", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { "content-type": "application/json" } }),
    ]));

    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(["host"]);
  });
});

// -----------------------------------------------------------------------------
// Rule 5: secret query parameters
// -----------------------------------------------------------------------------

describe("suggestHarVariables - query", () => {
  it("suggests a long query value whose name looks like a credential", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1/users?token=supersecret1&page=2" }),
    ]));

    expect(of(suggestions, "query")).toEqual([{
      name: "token",
      value: "supersecret1",
      secret: true,
      kind: "query",
      occurrences: 1,
      reasonCode: "secret-query-param",
      detail: 'Query parameter "token" carries the same secret in 1 imported request',
    }]);
  });

  it("detects every credential-looking query name above the length threshold", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1?api_key=12345678&password=12345678&sig=12345678&auth=12345678&pageSize=10" }),
    ]));

    expect(of(suggestions, "query").map((suggestion) => suggestion.name))
      .toEqual(["api_key", "password", "sig", "auth"]);
  });

  it("ignores a non-secret query parameter even when its value is long", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1/users?page=2&dateFrom=20261001" }),
    ]));

    expect(of(suggestions, "query")).toEqual([]);
  });

  it("ignores a credential-looking name whose value is too short", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1/users?key=abc1234" }),
    ]));

    expect(of(suggestions, "query")).toEqual([]);
  });

  it("skips a query parameter whose value changes between requests", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", { url: "https://api.example.com/v1?token=supersecret1" }),
      request("b", { url: "https://api.example.com/v2?token=supersecret2" }),
    ]));

    expect(of(suggestions, "query")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Names: validity and de-duplication
// -----------------------------------------------------------------------------

describe("suggestHarVariables - names", () => {
  it("de-duplicates colliding variable names with a numeric suffix", () => {
    // The same api key travels as a header and as a query parameter, so both
    // candidates want the name `apikey`.
    const suggestions = suggestHarVariables(graph([
      request("a", {
        url: "https://api.example.com/v1?apikey=query-123456",
        headers: { apikey: "header-123456" },
      }),
    ]));

    expect(named(suggestions, "apikey")).toMatchObject({
      kind: "api-key", value: "header-123456",
    });
    expect(named(suggestions, "apikey2")).toMatchObject({
      kind: "query", value: "query-123456",
    });
  });

  it("always produces valid, unique variable names", () => {
    const suggestions = suggestHarVariables(graph([
      request("a", {
        url: "https://api.example.com/v1/users?token=supersecret1",
        method: "POST",
        headers: {
          authorization: "Bearer abc123",
          cookie: "9lives=x; ; weird[name]=y; session=shared",
          "x-api-key": "key-123456",
        },
      }),
      request("b", {
        url: "https://other.example.com/b",
        headers: { cookie: "session=shared", "x-api-key": "key-123456" },
      }),
    ]));

    expect(suggestions.length).toBeGreaterThan(5);
    for (const suggestion of suggestions) {
      expect(isValidVariableName(suggestion.name), suggestion.name).toBe(true);
      expect(suggestion.name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(suggestions.map((suggestion) => suggestion.name)).size)
      .toBe(suggestions.length);
  });

  it("truncates an over-long name so the suggestion stays valid", () => {
    const long = "s".repeat(120);
    const suggestions = suggestHarVariables(graph([
      request("a", { headers: { cookie: `${long}=value1` } }),
    ]));

    const name = named(suggestions, `cookie_${"s".repeat(57)}`);
    expect(name).toMatchObject({ value: "value1" });
    expect(name?.name.length).toBe(64);
    expect(isValidVariableName(name?.name ?? "")).toBe(true);
  });

  it("reports occurrences against the composition when one is given", () => {
    const imported = graph([
      request("a", { headers: { authorization: "Bearer shared" } }),
      request("b", { headers: { authorization: "Bearer shared" } }),
    ]);
    const { composition } = harGraphToComposition(imported);
    const trimmed: GraphDraftComposition = { ...composition, nodes: composition.nodes.slice(0, 1) };

    const fromGraph = suggestHarVariables(imported);
    const fromComposition = suggestHarVariables(imported, trimmed);

    expect(named(fromGraph, "authToken")?.occurrences).toBe(2);
    expect(named(fromComposition, "authToken")?.occurrences).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Applying the suggestions
// -----------------------------------------------------------------------------

const suggestion = (
  name: string,
  value: string,
  overrides: Partial<HarVariableSuggestion> = {},
): HarVariableSuggestion => ({
  name,
  value,
  secret: false,
  kind: "host",
  occurrences: 1,
  reasonCode: "single-origin",
  detail: "test suggestion",
  ...overrides,
});

const httpNode = (
  composition: GraphDraftComposition,
  id: string,
): GraphDraftComposition["nodes"][number] | undefined =>
  composition.nodes.find((node) => node.id === id);

describe("applyVariableSuggestions", () => {
  const imported = graph([
    request("a", {
      url: "https://api.example.com/v1/login?token=supersecret1",
      method: "POST",
      headers: { authorization: "Bearer abc123", accept: "application/json" },
      body: '{"token":"supersecret1"}',
      contentType: "application/json",
    }),
  ]);

  it("rewrites url, header values and body text without mutating the input", () => {
    const { composition } = harGraphToComposition(imported);
    const before = structuredClone(composition);

    const applied = applyVariableSuggestions(composition, suggestHarVariables(imported));

    expect(applied).not.toBe(composition);
    expect(composition).toEqual(before);
    const node = httpNode(applied, "a");
    if (node?.kind !== "http-request") throw new Error("expected an http-request node");
    expect(node.parameters?.url).toEqual({
      kind: "literal", value: "{{baseUrl}}/v1/login?token={{token}}",
    });
    expect(node.parameters?.headers).toEqual([
      { name: "authorization", value: { kind: "literal", value: "{{authToken}}" } },
      // Unrelated header values are left alone.
      { name: "accept", value: { kind: "literal", value: "application/json" } },
    ]);
    expect(node.parameters?.body).toEqual({
      kind: "json", value: { kind: "literal", value: '{"token":"{{token}}"}' },
    });
    expect(graphDraftCompositionSchema.safeParse(applied).success).toBe(true);
  });

  it("replaces the longest value first so a shorter value cannot corrupt it", () => {
    const { composition } = harGraphToComposition(imported);
    const applied = applyVariableSuggestions(composition, [
      suggestion("apiHost", "api.example.com"),
      suggestion("originUrl", "https://api.example.com"),
    ]);

    const node = httpNode(applied, "a");
    if (node?.kind !== "http-request") throw new Error("expected an http-request node");
    expect(node.parameters?.url).toEqual({
      kind: "literal", value: "{{originUrl}}/v1/login?token=supersecret1",
    });
  });

  it("leaves reference-valued parameters untouched", () => {
    const composition: GraphDraftComposition = {
      version: 1,
      nodes: [{
        id: "a",
        kind: "http-request",
        references: [],
        parameters: {
          method: "GET",
          url: { kind: "reference", reference: { producerNodeId: "producer", output: "url" } },
        },
      }],
      connections: [],
    };
    const before = structuredClone(composition);

    const applied = applyVariableSuggestions(composition, [
      suggestion("baseUrl", "https://api.example.com"),
    ]);

    expect(applied).not.toBe(composition);
    expect(applied).toEqual(before);
    expect(composition).toEqual(before);
  });

  it("returns an equivalent composition when there is nothing to replace", () => {
    const { composition } = harGraphToComposition(imported);

    const applied = applyVariableSuggestions(composition, []);

    expect(applied).not.toBe(composition);
    expect(applied).toEqual(composition);
  });

  it("ignores suggestions with an invalid name or an empty value", () => {
    const { composition } = harGraphToComposition(imported);

    const applied = applyVariableSuggestions(composition, [
      suggestion("bad name", "https://api.example.com"),
      suggestion("empty", ""),
    ]);

    expect(applied).toEqual(composition);
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

describe.skipIf(!hasReferenceHar)("suggestHarVariables acceptance on docs/examploHar.har", () => {
  const reference = (): Har => {
    const parsed: unknown = JSON.parse(readFileSync("docs/examploHar.har", "utf8"));
    expect(validateHar(parsed)).toBe(true);
    return parsed as Har;
  };

  it("suggests one variable per origin and invents no credentials", () => {
    const imported = importHar(reference(), { name: "Reference", excludeStatic: false });
    const suggestions = suggestHarVariables(imported.graph);

    // The reference export has two origins and no Authorization, Cookie or api
    // key header, so only host suggestions are expected here.
    expect(suggestions.every((current) => current.kind === "host")).toBe(true);
    expect(suggestions.map((current) => current.name)).toEqual(["baseUrl1", "baseUrl2"]);
    expect(suggestions.map((current) => current.value)).toEqual([
      "https://np-consiglia.digitalgex.com",
      "https://backend-consiglia-qa.digitalgex.com",
    ]);
    expect(suggestions.every((current) => current.secret === false)).toBe(true);
    expect(suggestions.reduce((total, current) => total + current.occurrences, 0)).toBe(16);
  });
});
