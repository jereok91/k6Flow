/**
 * K6F5-01: Graph-to-K6 translator tests.
 */

import { describe, it, expect } from "vitest";
import { translateToK6 } from "./k6-translator";
import type { GraphDraftComposition } from "./graph-composition";

describe("translateToK6", () => {
  it("generates empty script for empty graph", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("import http from 'k6/http';");
    expect(result.script).toContain("export const options = {");
    expect(result.script).toContain("vus: 1,");
    expect(result.script).toContain("duration: '30s',");
    expect(result.script).toContain("export default function () {");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it("respects custom options", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [],
      connections: [],
    };

    const result = translateToK6(graph, { vus: 10, duration: "1m" });

    expect(result.script).toContain("vus: 10,");
    expect(result.script).toContain("duration: '1m',");
  });

  it("uses iterations when specified", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [],
      connections: [],
    };

    const result = translateToK6(graph, { vus: 5, iterations: 100 });

    expect(result.script).toContain("iterations: 100,");
    expect(result.script).not.toContain("duration:");
  });

  it("generates http-request node", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "node-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://api.example.com/users" },
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("// node-1");
    expect(result.script).toContain("http.get('https://api.example.com/users'");
  });

  it("generates POST request with body", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "node-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "POST",
            url: { kind: "literal", value: "https://api.example.com/users" },
            body: { kind: "text", value: { kind: "literal", value: '{"name":"test"}' } },
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("http.post(");
    expect(result.script).toContain('{"name":"test"}');
  });

  it("generates authentication node", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "auth-1",
          kind: "authentication",
          references: [],
          parameters: {
            method: {
              kind: "http",
              request: {
                method: "POST",
                url: { kind: "literal", value: "https://api.example.com/login" },
              },
            },
            outputs: [
              {
                name: "token",
                selector: { kind: "json-path", path: ["data", "accessToken"] },
                expectedType: "string",
                required: true,
              },
            ],
            onOutputFailure: "stop-current-vu-iteration",
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("// auth-1");
    expect(result.script).toContain("http.post('https://api.example.com/login'");
    expect(result.script).toContain(".json('data.accessToken')");
  });

  it("generates response-validation node with status check", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://api.example.com/data" },
          },
        },
        {
          id: "check-1",
          kind: "response-validation",
          references: [{ producerNodeId: "req-1", output: "response" }],
          parameters: {
            version: 1,
            response: { producerNodeId: "req-1", output: "response" },
            checks: [
              { kind: "status", name: "is-200", operator: "eq", expected: 200 },
            ],
            onCheckFailure: "record-failure-and-continue",
          },
        },
      ],
      connections: [{ source: "req-1", target: "check-1" }],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("import { check } from 'k6';");
    expect(result.script).toContain("// check-1");
    expect(result.script).toContain("check(req_1_res, {");
    expect(result.script).toContain("'is-200': (r) => r.status === 200,");
  });

  it("generates user-pool node", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "pool-1",
          kind: "user-pool",
          references: [],
          parameters: {
            version: 1,
            attachment: { id: "users" },
            allocation: "csv-order-distinct-row-per-vu",
            onInsufficientCapacity: "reject-before-execution",
            outputs: [
              { header: "username", name: "user", expectedType: "string", required: true },
              { header: "password", name: "pass", expectedType: "string", required: true },
            ],
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("import { SharedArray } from 'k6/data';");
    expect(result.script).toContain("import papaparse from");
    // JSON.stringify produces double quotes for safe string escaping
    expect(result.script).toContain('const pool_1_data = new SharedArray("users"');
    expect(result.script).toContain('open("./users.csv")');
    expect(result.script).toContain("pool_1_data[__VU % pool_1_data.length]");
    expect(result.requiresFiles).toContain("users.csv");
  });

  it("generates body-text contains check", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://example.com" },
          },
        },
        {
          id: "check-1",
          kind: "response-validation",
          references: [{ producerNodeId: "req-1", output: "response" }],
          parameters: {
            version: 1,
            response: { producerNodeId: "req-1", output: "response" },
            checks: [
              { kind: "body-text", name: "has-success", predicate: { operator: "contains-literal", expected: "success" } },
            ],
            onCheckFailure: "record-failure-and-continue",
          },
        },
      ],
      connections: [{ source: "req-1", target: "check-1" }],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("r.body.includes('success')");
  });

  it("is deterministic: same input produces same output", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "b-node", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://b.com" } } },
        { id: "a-node", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://a.com" } } },
        { id: "c-node", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://c.com" } } },
      ],
      connections: [],
    };

    const result1 = translateToK6(graph);
    const result2 = translateToK6(graph);
    const result3 = translateToK6(graph);

    expect(result1.script).toBe(result2.script);
    expect(result2.script).toBe(result3.script);
  });

  it("respects topological order based on connections", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "z-req", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://z.com" } } },
        { id: "a-check", kind: "response-validation", references: [{ producerNodeId: "z-req", output: "response" }], parameters: { version: 1, response: { producerNodeId: "z-req", output: "response" }, checks: [{ kind: "status", name: "ok", operator: "eq", expected: 200 }], onCheckFailure: "record-failure-and-continue" } },
      ],
      connections: [{ source: "z-req", target: "a-check" }],
    };

    const result = translateToK6(graph);
    const reqIndex = result.script.indexOf("// z-req");
    const checkIndex = result.script.indexOf("// a-check");

    expect(reqIndex).toBeLessThan(checkIndex);
  });

  it("warns about cycles", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "a", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://a.com" } } },
        { id: "b", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://b.com" } } },
      ],
      connections: [
        { source: "a", target: "b" },
        { source: "b", target: "a" }, // Cycle
      ],
    };

    const result = translateToK6(graph);

    expect(result.warnings).toContain("Graph contains cycles; some nodes may not execute");
  });

  it("escapes special characters in strings", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "POST",
            url: { kind: "literal", value: "https://api.example.com" },
            body: { kind: "text", value: { kind: "literal", value: "line1\nline2" } },
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("line1\\nline2");
  });

  it("generates duration-ms check", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "req-1", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://fast.com" } } },
        { id: "check-1", kind: "response-validation", references: [{ producerNodeId: "req-1", output: "response" }], parameters: { version: 1, response: { producerNodeId: "req-1", output: "response" }, checks: [{ kind: "duration-ms", name: "fast", operator: "lt", expected: 500 }], onCheckFailure: "record-failure-and-continue" } },
      ],
      connections: [{ source: "req-1", target: "check-1" }],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("r.timings.duration < 500");
  });
});

describe("translateToK6 variables", () => {
  type Call = { method: string; url: unknown; body: unknown; params: { headers: Record<string, unknown> } };

  /** Executes the generated default function with fake k6 globals and records http calls. */
  function execute(script: string, env: Record<string, string> = {}): Call[] {
    const calls: Call[] = [];
    const response = { json: () => "tok", status: 200, body: "", timings: { duration: 1 } };
    const http = new Proxy({}, {
      get: (_target, method: string) => (url: unknown, ...rest: unknown[]) => {
        const hasBody = rest.length === 2;
        calls.push({
          method, url, body: hasBody ? rest[0] : undefined,
          params: (hasBody ? rest[1] : rest[0]) as Call["params"],
        });
        return response;
      },
    });
    const runnable = script
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .join("\n")
      .replace("export const options", "const options")
      .replace("export default function ()", "function __default()");
    new Function("http", "__ENV", "check", "__VU", `${runnable}\n__default();`)(http, env, () => true, 1);
    return calls;
  }

  const httpNode = (parameters: Record<string, unknown>, id = "req-1") => ({
    id, kind: "http-request" as const, references: [], parameters,
  }) as unknown as GraphDraftComposition["nodes"][number];
  const graphOf = (...nodes: GraphDraftComposition["nodes"]): GraphDraftComposition => ({
    version: 1, nodes, connections: [],
  });
  const lit = (value: string) => ({ kind: "literal" as const, value });

  const vars = new Map([
    ["baseUrl", { value: "https://api.example.com", secret: false }],
    ["token", { secret: true }],
    ["user", { value: "alice", secret: false }],
  ]);

  it("keeps exact output when no placeholders are present", () => {
    const graph = graphOf(httpNode({
      method: "POST", url: lit("https://x.test/a"),
      headers: [{ name: "X-A", value: lit("b") }],
      body: { kind: "json", value: lit('{"a":1}') },
    }));
    const plain = translateToK6(graph);
    const withVars = translateToK6(graph, { variables: vars });
    expect(withVars.script).toBe(plain.script);
    expect(withVars.errors).toEqual([]);
    expect(withVars.requiredEnv).toEqual([]);
  });

  it("leaves placeholders untouched when no variables option is supplied", () => {
    const result = translateToK6(graphOf(httpNode({ method: "GET", url: lit("{{baseUrl}}/x") })));
    expect(result.script).toContain("http.get('{{baseUrl}}/x'");
    expect(result.errors).toEqual([]);
    expect(result.requiredEnv).toEqual([]);
  });

  it("inlines a non-secret variable in the URL", () => {
    const result = translateToK6(
      graphOf(httpNode({ method: "GET", url: lit("{{baseUrl}}/auth/login") })),
      { variables: vars },
    );
    expect(result.script).toContain('http.get("https://api.example.com" + "/auth/login", {');
    expect(result.errors).toEqual([]);
    expect(execute(result.script)[0].url).toBe("https://api.example.com/auth/login");
  });

  it("interpolates the authentication request URL", () => {
    const graph = graphOf({
      id: "auth-1", kind: "authentication", references: [],
      parameters: {
        method: { kind: "http", request: { method: "POST", url: lit("{{baseUrl}}/auth/login") } },
        outputs: [], onOutputFailure: "stop-current-vu-iteration",
      },
    } as GraphDraftComposition["nodes"][number]);
    const result = translateToK6(graph, { variables: vars });
    expect(result.script).toContain('http.post("https://api.example.com" + "/auth/login", null, {');
    expect(execute(result.script)[0].url).toBe("https://api.example.com/auth/login");
  });

  it("reads a secret header from __ENV and reports requiredEnv", () => {
    const result = translateToK6(
      graphOf(httpNode({
        method: "GET", url: lit("https://x.test"),
        headers: [{ name: "Authorization", value: lit("Bearer {{token}}") }],
      })),
      { variables: vars },
    );
    expect(result.script).toContain(`headers: { 'Authorization': "Bearer " + __ENV["K6FLOW_VAR_TOKEN"] },`);
    expect(result.requiredEnv).toEqual(["K6FLOW_VAR_TOKEN"]);
    const [call] = execute(result.script, { K6FLOW_VAR_TOKEN: "s3cr3t" });
    expect(call.params.headers.Authorization).toBe("Bearer s3cr3t");
  });

  it("never writes a secret value into the script", () => {
    const result = translateToK6(
      graphOf(httpNode({ method: "GET", url: lit("https://x.test/{{token}}") })),
      { variables: new Map([["token", { value: "TOP-SECRET", secret: true }]]) },
    );
    expect(result.script).not.toContain("TOP-SECRET");
    expect(result.requiredEnv).toEqual(["K6FLOW_VAR_TOKEN"]);
  });

  it("interpolates a JSON body on the raw text", () => {
    const result = translateToK6(
      graphOf(httpNode({
        method: "POST", url: lit("{{baseUrl}}/login"),
        body: { kind: "json", value: lit('{"user":"{{user}}","pass":"{{token}}"}') },
      })),
      { variables: vars },
    );
    expect(result.script).toContain("'Content-Type': 'application/json'");
    const [call] = execute(result.script, { K6FLOW_VAR_TOKEN: "pw" });
    expect(call.body).toBe('{"user":"alice","pass":"pw"}');
    expect(JSON.parse(call.body as string)).toEqual({ user: "alice", pass: "pw" });
  });

  it("interpolates text, xml and form bodies", () => {
    for (const kind of ["text", "xml", "form"]) {
      const result = translateToK6(
        graphOf(httpNode({ method: "PUT", url: lit("https://x.test"), body: { kind, value: lit("u={{user}}") } })),
        { variables: vars },
      );
      expect(execute(result.script)[0].body).toBe("u=alice");
    }
  });

  it("handles mixed strings with several variables", () => {
    const result = translateToK6(
      graphOf(httpNode({ method: "GET", url: lit("{{baseUrl}}/users/{{user}}?t={{token}}&x={{user}}") })),
      { variables: vars },
    );
    const [call] = execute(result.script, { K6FLOW_VAR_TOKEN: "T" });
    expect(call.url).toBe("https://api.example.com/users/alice?t=T&x=alice");
    expect(result.requiredEnv).toEqual(["K6FLOW_VAR_TOKEN"]);
  });

  it("cannot be broken out of by hostile values or literal parts", () => {
    const hostile = "`${globalThis.pwned=1}`'\"\\\n\u2028</script><script>x</script>";
    const literal = "'); globalThis.pwned = 1; ('`${2}`\"\n</script>";
    const result = translateToK6(
      graphOf(httpNode({
        method: "POST", url: lit(`https://x.test/${literal}{{evil}}`),
        headers: [{ name: "X-Evil", value: lit(`${literal}{{evil}}`) }],
        body: { kind: "json", value: lit(`${literal}{{evil}}${literal}`) },
      })),
      { variables: new Map([["evil", { value: hostile, secret: false }]]) },
    );
    expect(result.script).not.toContain("</script>");
    const [call] = execute(result.script);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
    expect(call.url).toBe(`https://x.test/${literal}${hostile}`);
    expect(call.params.headers["X-Evil"]).toBe(`${literal}${hostile}`);
    expect(call.body).toBe(`${literal}${hostile}${literal}`);
  });

  it("reports unknown variables as errors without throwing", () => {
    const result = translateToK6(
      graphOf(
        httpNode({ method: "GET", url: lit("{{nope}}/a"), headers: [{ name: "X", value: lit("{{nope}}{{other}}") }] }),
      ),
      { variables: vars },
    );
    expect(result.errors).toEqual([
      { code: "unknown-variable", nodeId: "req-1", variable: "nope", message: expect.stringContaining("nope") },
      { code: "unknown-variable", nodeId: "req-1", variable: "other", message: expect.stringContaining("other") },
    ]);
    expect(execute(result.script)[0].url).toBe("{{nope}}/a");
  });

  it("reports a non-secret variable without a value", () => {
    const result = translateToK6(
      graphOf(httpNode({ method: "GET", url: lit("{{empty}}") })),
      { variables: new Map([["empty", { secret: false }]]) },
    );
    expect(result.errors).toEqual([
      { code: "missing-value", nodeId: "req-1", variable: "empty", message: expect.stringContaining("empty") },
    ]);
  });

  it("returns requiredEnv unique and sorted", () => {
    const secrets = new Map([
      ["zeta", { secret: true }], ["alpha", { secret: true }], ["unused", { secret: true }],
    ]);
    const result = translateToK6(
      graphOf(
        httpNode({ method: "GET", url: lit("https://x.test/{{zeta}}/{{alpha}}") }, "a"),
        httpNode({ method: "GET", url: lit("https://x.test/{{zeta}}") }, "b"),
      ),
      { variables: secrets },
    );
    expect(result.requiredEnv).toEqual(["K6FLOW_VAR_ALPHA", "K6FLOW_VAR_ZETA"]);
  });

  it("reports referenced secrets whose env names collide", () => {
    const result = translateToK6(
      graphOf(httpNode({ method: "GET", url: lit("https://x.test/{{api.key}}/{{api-key}}") })),
      { variables: new Map([["api.key", { secret: true }], ["api-key", { secret: true }]]) },
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "secret-env-collision", variable: "api-key", nodeId: "req-1" }),
    ]);
    expect(result.errors[0].message).toContain("K6FLOW_VAR_API_KEY");
  });
});

describe("translateToK6 disabled nodes", () => {
  const lit = (value: string) => ({ kind: "literal" as const, value });
  const request = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "http-request" as const, references: [],
    parameters: { method: "GET" as const, url: lit(url) }, ...extra,
  }) as GraphDraftComposition["nodes"][number];
  const chain = (...nodes: GraphDraftComposition["nodes"]): GraphDraftComposition => ({
    version: 1, nodes,
    connections: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id })),
  });

  it("produces identical output for nodes without metadata and explicit enabled metadata", () => {
    const plain = translateToK6(chain(request("a", "https://a.test")));
    const labelled = translateToK6(chain(request("a", "https://a.test",
      { label: "Home", position: { x: 1, y: 2 }, disabled: false })));
    expect(labelled).toEqual(plain);
  });

  it("omits a disabled middle node and keeps linear order of the rest", () => {
    const result = translateToK6(chain(request("a", "https://a.test"),
      request("b", "https://b.test", { disabled: true }), request("c", "https://c.test")));
    expect(result.errors).toEqual([]);
    expect(result.script).not.toContain("https://b.test");
    expect(result.script).not.toContain("// b");
    expect(result.script.indexOf("https://a.test")).toBeLessThan(result.script.indexOf("https://c.test"));
    expect(result.script).toBe(translateToK6(chain(request("a", "https://a.test"),
      request("c", "https://c.test"))).script);
  });

  it("omits disabled checks and user pools from imports, setup and files", () => {
    const pool = { id: "pool", kind: "user-pool", references: [], disabled: true,
      parameters: { version: 1, attachment: { id: "users" }, allocation: "csv-order-distinct-row-per-vu",
        onInsufficientCapacity: "reject-before-execution",
        outputs: [{ header: "u", name: "u", expectedType: "string", required: true }] } };
    const checks = { id: "chk", kind: "response-validation", disabled: true,
      references: [{ producerNodeId: "a", output: "response" }],
      parameters: { version: 1, response: { producerNodeId: "a", output: "response" },
        checks: [{ name: "ok", kind: "status", operator: "eq", expected: 200 }],
        onCheckFailure: "record-failure-and-continue" } };
    const result = translateToK6(chain(pool as unknown as GraphDraftComposition["nodes"][number],
      request("a", "https://a.test"), checks as unknown as GraphDraftComposition["nodes"][number]));
    expect(result.requiresFiles).toEqual([]);
    expect(result.script).not.toContain("SharedArray");
    expect(result.script).not.toContain("check(");
    expect(result.script).not.toContain("from 'k6';");
    expect(result.errors).toEqual([]);
  });

  it("blocks an enabled node that references a disabled producer", () => {
    const checks = { id: "chk", kind: "response-validation",
      references: [{ producerNodeId: "a", output: "response" }],
      parameters: { version: 1, response: { producerNodeId: "a", output: "response" },
        checks: [{ name: "ok", kind: "status", operator: "eq", expected: 200 }],
        onCheckFailure: "record-failure-and-continue" } };
    const result = translateToK6(chain(request("a", "https://a.test", { disabled: true }),
      checks as unknown as GraphDraftComposition["nodes"][number]));
    expect(result.errors).toEqual([{
      code: "disabled-dependency", nodeId: "chk", variable: "a",
      message: "Node chk depends on disabled node a",
    }]);
  });

  it("blocks an authentication body template fed only by a disabled user pool", () => {
    const pool = { id: "pool", kind: "user-pool", references: [], disabled: true,
      parameters: { version: 1, mode: "manual", manualUsers: [{ username: "u" }],
        allocation: "csv-order-distinct-row-per-vu", onInsufficientCapacity: "reject-before-execution",
        outputs: [] } };
    const auth = { id: "auth", kind: "authentication", references: [],
      parameters: { method: { kind: "http", request: { method: "POST", url: lit("https://a.test/login") } },
        bodyTemplate: [{ key: "user", variable: "username" }], outputs: [],
        onOutputFailure: "stop-current-vu-iteration" } };
    const result = translateToK6(chain(pool as unknown as GraphDraftComposition["nodes"][number],
      auth as unknown as GraphDraftComposition["nodes"][number]));
    expect(result.errors).toEqual([expect.objectContaining({
      code: "disabled-dependency", nodeId: "auth", variable: "pool" })]);
  });

  it.each([1, 2])("blocks a graph with %i disabled nodes and no enabled nodes", (count) => {
    const result = translateToK6(chain(...Array.from({ length: count }, (_, index) =>
      request(`disabled-${index}`, "https://disabled.test", { disabled: true }))));
    expect(result.errors).toEqual([{
      code: "no-enabled-nodes", nodeId: "", variable: "",
      message: "Graph has no enabled nodes; enable at least one node before running",
    }]);
    expect(result.script).not.toContain("https://disabled.test");
  });

  it("does not report dependencies of disabled consumers with an enabled independent node", () => {
    const graph = chain(request("a", "https://a.test", { disabled: true }),
      request("b", "https://b.test", { disabled: true,
        references: [{ producerNodeId: "a", output: "response" }] }));
    graph.nodes.push(request("independent", "https://independent.test"));
    const result = translateToK6(graph);
    expect(result.errors).toEqual([]);
    expect(result.script).toContain("https://independent.test");
  });
});
