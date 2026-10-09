import { describe, expect, it } from "vitest";
const { runInNewContext } = await import("node:vm" as string) as {
  runInNewContext(source: string, context: Record<string, unknown>): unknown;
};
import { translateToK6 } from "./k6-translator";
import type { GraphDraftComposition } from "./graph-composition";
import type { ResolvedVariables } from "./variables";
import { diagnosticEventSchema, DIAGNOSTIC_METRIC } from "./diagnostic";

const graph: GraphDraftComposition = { version: 1, nodes: [
  { id: "a", kind: "http-request", references: [], parameters: {
    method: "GET", url: { kind: "literal", value: "https://example.test/path?old=1#frag" },
    query: [{ name: "q", value: { kind: "literal", value: "a &b" } },
      { name: "q", value: { kind: "literal", value: "two" } }],
  } },
  { id: "b", kind: "http-request", references: [], parameters: {
    method: "GET", url: { kind: "literal", value: "https://example.test/next" },
  } },
], connections: [{ source: "a", target: "b" }] };

function execute(input = graph, status = 200, extraction: unknown = "token", variables?: ResolvedVariables) {
  const result = translateToK6(input, { mode: "diagnostic", vus: 99, duration: "2h", variables });
  expect(result.errors).toEqual([]);
  const events: { value: number; tags: Record<string, string> }[] = [];
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let checkCalls = 0, predicates = 0;
  const source = result.script.replace(/^import .*;$/gm, "")
    .replace("export const options", "const options")
    .replace("export default function", "function main");
  runInNewContext(source + "\nmain();", {
    http: { request: (_method: string, url: string, body: unknown) => {
      if (status === -1) throw new Error("secret url/body/header text");
      urls.push(url); bodies.push(body);
      return { status, body: "ok", timings: { duration: 2 }, json: () => ({ token: extraction }) };
    } },
    check: (response: unknown, checks: Record<string, (value: unknown) => boolean>) => {
      checkCalls++;
      const results = Object.values(checks).map(predicate => { predicates++; return predicate(response); });
      return results.every(Boolean);
    },
    SharedArray: class { constructor(_name: string, init: () => unknown[]) { return init(); } },
    Counter: class {
      constructor(name: string) { expect(name).toBe(DIAGNOSTIC_METRIC); }
      add(value: number, tags: Record<string, string>) {
        diagnosticEventSchema.parse({ ...tags, seq: Number(tags.seq), httpStatus: Number(tags.httpStatus), elapsedMs: value });
        events.push({ value, tags });
      }
    },
    papaparse: { parse: () => ({ data: [] }) }, open: () => "",
    Date, __VU: 1,
  });
  return { result, events, urls, bodies, checkCalls, predicates };
}

describe("diagnostic execution (mocked k6, not native tracing)", () => {
  it("forces one iteration and emits ordered custom events with encoded query", () => {
    const { result, events, urls } = execute();
    expect(result.script).toContain("iterations: 1");
    expect(result.script).toContain("vus: 1");
    expect(result.script).not.toContain("duration:");
    expect(events.map(e => e.tags.event)).toEqual(["enter", "exit", "enter", "exit", "complete"]);
    expect(events.map(e => Number(e.tags.seq))).toEqual([1, 2, 3, 4, 5]);
    expect(urls[0]).toBe("https://example.test/path?old=1&q=a%20%26b&q=two#frag");
  });
  it("stops after HTTP failure, skips successors and completes failed", () => {
    const { events, urls } = execute(graph, 500);
    expect(urls).toHaveLength(1);
    expect(events.map(e => e.tags.event)).toEqual(["enter", "exit", "skipped", "complete"]);
    expect(events.at(-1)?.tags.outcome).toBe("failure");
    expect(events[1].tags.reason).toBe("http");
    expect(JSON.stringify(events)).not.toContain("example.test");
  });
  it("encodes templated query values and existing empty query separators", () => {
    const input: GraphDraftComposition = { version: 1, nodes: [{ ...graph.nodes[0], kind: "http-request", parameters: {
      method: "GET", url: { kind: "literal", value: "https://example.test/?#f" },
      query: [{ name: "q'" + String.fromCharCode(13, 10), value: { kind: "literal", value: "{{value}}" } }],
    } }], connections: [] };
    const { urls } = execute(input, 200, "token", new Map([["value", { value: "a?&=#", secret: false }]]));
    expect(urls).toEqual(["https://example.test/?q'%0D%0A=a%3F%26%3D%23#f"]);
  });
  it("catches request exceptions without disclosing exception text", () => {
    const { events } = execute(graph, -1);
    expect(events[1].tags.reason).toBe("exception");
    expect(events[2].tags.event).toBe("skipped");
    expect(events.at(-1)?.tags.outcome).toBe("failure");
    expect(JSON.stringify(events)).not.toContain("secret");
  });
  it("skips disabled nodes without HTTP execution", () => {
    const { events, urls } = execute({ ...graph, nodes: graph.nodes.map(node => node.id === "a" ? { ...node, disabled: true } : node) });
    expect(urls).toHaveLength(1);
    expect(events.map(e => e.tags.event)).toEqual(["skipped", "enter", "exit", "complete"]);
    expect(events[0].tags.reason).toBe("disabled");
  });
  it("evaluates validation booleans exactly once and stops on business failure after HTTP success", () => {
    const validation: GraphDraftComposition = { ...graph, nodes: [graph.nodes[0], {
      id: "checks", kind: "response-validation", references: [{ producerNodeId: "a", output: "response" }],
      parameters: { version: 1, response: { producerNodeId: "a", output: "response" },
        checks: [{ kind: "status", name: "private'" + String.fromCharCode(13, 10, 34, 92) + "check", operator: "eq", expected: 201 },
          { kind: "body-text", name: "other", predicate: { operator: "contains-literal", expected: "ok" } }],
        onCheckFailure: "record-failure-and-continue" },
    }, graph.nodes[1]], connections: [{ source: "a", target: "checks" }, { source: "checks", target: "b" }] };
    const { events, urls, checkCalls, predicates } = execute(validation);
    expect(checkCalls).toBe(1); expect(predicates).toBe(2); expect(urls).toHaveLength(1);
    expect(events[1].tags.outcome).toBe("success");
    expect(events[3].tags.reason).toBe("check");
    expect(events[4].tags.event).toBe("skipped");
    expect(JSON.stringify(events)).not.toContain("private");
  });
  it("retains pool/auth outputs in downstream scope, uses query templates/references and fails missing extraction", () => {
    const chain: GraphDraftComposition = { version: 1, nodes: [
      { id: "pool", kind: "user-pool", references: [], parameters: {
        version: 1, mode: "manual", manualUsers: [{ username: "u&secret", password: "p" }],
        outputs: [{ header: "username", name: "user", required: true, expectedType: "string" }],
        allocation: "csv-order-distinct-row-per-vu", onInsufficientCapacity: "reject-before-execution" } },
      { id: "auth", kind: "authentication", references: [{ producerNodeId: "pool", output: "user" }], parameters: {
        method: { kind: "http", request: { method: "POST", url: { kind: "literal", value: "https://example.test/auth?x=1#f" },
          query: [{ name: "u", value: { kind: "reference", reference: { producerNodeId: "pool", output: "user" } } }] } },
        bodyTemplate: [{ key: "username", variable: "user" }],
        outputs: [{ name: "token", expectedType: "string", required: true, selector: { kind: "json-path", path: ["token"] } }],
        onOutputFailure: "stop-current-vu-iteration" } },
      { id: "next", kind: "http-request", references: [{ producerNodeId: "auth", output: "token" }], parameters: {
        method: "GET", url: { kind: "literal", value: "https://example.test/next" },
        query: [{ name: "token", value: { kind: "reference", reference: { producerNodeId: "auth", output: "token" } } }] } },
    ], connections: [{ source: "pool", target: "auth" }, { source: "auth", target: "next" }] };
    const success = execute(chain);
    expect(success.urls).toEqual(["https://example.test/auth?x=1&u=u%26secret#f", "https://example.test/next?token=token"]);
    expect(success.bodies[0]).toBe('{"username":"u&secret"}');
    expect(success.events.at(-1)?.tags.outcome).toBe("success");
    const failed = execute(chain, 200, null);
    expect(failed.urls).toHaveLength(1);
    expect(failed.events[3].tags.reason).toBe("extraction");
    expect(failed.events[4].tags.event).toBe("skipped");
    expect(JSON.stringify(success.events)).not.toContain("u&secret");
  });
  it("serializes hostile URL and node ID literals without code execution", () => {
    const hostile = String.fromCharCode(34, 92, 13, 10);
    const id = "node'" + hostile + "throw new Error('injection')";
    const url = "https://example.test/'" + hostile;
    const input: GraphDraftComposition = { version: 1, nodes: [{ ...graph.nodes[0], kind: "http-request", id,
      parameters: { method: "GET", url: { kind: "literal", value: url + "end" } } }], connections: [] };
    const { events, urls } = execute(input);
    expect(urls).toEqual([url + "end"]);
    expect(events[0].tags.nodeId).toBe(id);
  });
  it.each(["load", "diagnostic"] as const)("executes distinct hostile output names and downstream references in %s", mode => {
    const names = ["a$b", "a_b", "res", "body", "__output0"];
    const input: GraphDraftComposition = { version: 1, nodes: [
      { id: "auth", kind: "authentication", references: [], parameters: {
        method: { kind: "http", request: { method: "POST", url: { kind: "literal", value: "https://example.test/auth" } } },
        outputs: names.map((name, i) => ({ name, expectedType: "string", required: true,
          selector: { kind: "json-path", path: [`field${i}`] } })), onOutputFailure: "stop-current-vu-iteration",
      } },
      ...["auth$res", "auth_res", "9'\nnode", "__k6flow_node0"].map(id => ({ id, kind: "http-request" as const,
        references: names.map(output => ({ producerNodeId: "auth", output })), parameters: {
          method: "GET" as const, url: { kind: "literal" as const, value: "https://example.test/next" },
          headers: names.map(name => ({ name, value: { kind: "reference" as const, reference: { producerNodeId: "auth", output: name } } })),
          query: names.map(name => ({ name, value: { kind: "reference" as const, reference: { producerNodeId: "auth", output: name } } })),
        } })),
    ], connections: ["auth$res", "auth_res", "9'\nnode", "__k6flow_node0"].map((target, i, ids) => ({ source: i === 0 ? "auth" : ids[i - 1], target })) };
    const result = translateToK6(input, { mode });
    expect(result.errors).toEqual([]);
    expect(translateToK6(input, { mode }).script).toBe(result.script);
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const response = { status: 200, json: (path?: string) => path ? `value${path.slice(5)}`
      : Object.fromEntries(names.map((_, i) => [`field${i}`, `value${i}`])) };
    const request = (_method: string, url: string, _body: unknown, options: { headers: Record<string, string> }) => {
      calls.push({ url, headers: options.headers }); return response;
    };
    runInNewContext(result.script.replace(/^import .*;$/gm, "").replace("export const options", "const options")
      .replace("export default function", "function main") + "\nmain();", {
      http: { request, post: (url: string, body: unknown, options: { headers: Record<string, string> }) => request("POST", url, body, options),
        get: (url: string, options: { headers: Record<string, string> }) => request("GET", url, null, options) },
      Counter: class { add() {} }, Date,
    });
    expect(calls).toHaveLength(5);
    for (const call of calls.slice(1)) {
      expect(call.headers).toEqual(Object.fromEntries(names.map((name, i) => [name, `value${i}`])));
      expect(call.url).toBe("https://example.test/next?" + names.map((name, i) => `${encodeURIComponent(name)}=value${i}`).join("&"));
    }
  });
  it("executes 100 nodes and emits exactly 201 ordered events", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ ...graph.nodes[1], id: `node${String(i).padStart(3, "0")}` }));
    const { events, urls, result } = execute({ version: 1, nodes, connections: nodes.slice(1).map((node, i) => ({ source: nodes[i].id, target: node.id })) });
    expect(urls).toHaveLength(100);
    expect(result.diagnostic?.nodeIds).toEqual(nodes.map(node => node.id));
    expect(events).toHaveLength(201);
    expect(events.map(event => Number(event.tags.seq))).toEqual(Array.from({ length: 201 }, (_, i) => i + 1));
    expect(events.at(-1)?.tags.event).toBe("complete");
    expect(events.at(-1)?.tags.outcome).toBe("success");
  });
  it("executes a 128-byte multibyte ID but rejects 129 bytes", () => {
    const id = "é".repeat(64);
    const input = { version: 1 as const, nodes: [{ ...graph.nodes[1], id }], connections: [] };
    expect(execute(input).events[0].tags.nodeId).toBe(id);
    expect(translateToK6({ ...input, nodes: [{ ...input.nodes[0], id: id + "a" }] }, { mode: "diagnostic" }).errors[0].code).toBe("invalid-diagnostic");
  });
  it("fails an empty runtime CSV pool and skips downstream HTTP", () => {
    const input: GraphDraftComposition = { version: 1, nodes: [{ id: "pool", kind: "user-pool", references: [], parameters: {
      version: 1, mode: "csv", attachment: { id: "users" },
      outputs: [{ header: "username", name: "user", required: true, expectedType: "string" }],
      allocation: "csv-order-distinct-row-per-vu", onInsufficientCapacity: "reject-before-execution",
    } }, graph.nodes[1]], connections: [{ source: "pool", target: "b" }] };
    const { events, urls } = execute(input);
    expect(urls).toEqual([]);
    expect(events.map(event => event.tags.event)).toEqual(["enter", "exit", "skipped", "complete"]);
    expect(events[1].tags.reason).toBe("pool");
    expect(events.at(-1)?.tags.outcome).toBe("failure");
  });
  it("rejects empty, incomplete and cyclic diagnostic graphs", () => {
    for (const input of [ { version: 1, nodes: [], connections: [] },
      { ...graph, nodes: [{ id: "a", kind: "http-request", references: [] }], connections: [] },
      { ...graph, connections: [{ source: "a", target: "b" }, { source: "b", target: "a" }] },
      { version: 1, nodes: [{ id: "a", kind: "http-request", references: [],
        parameters: { method: "GET", url: { kind: "literal", value: "  " } } }], connections: [] },
      { ...graph, nodes: [{ ...graph.nodes[0], id: "a".repeat(129) }, graph.nodes[1]] },
      { ...graph, nodes: [{ ...graph.nodes[0], kind: "mock-palette" }] },
      { ...graph, nodes: graph.nodes.map(node => ({ ...node, disabled: true })) },
    ]) expect(translateToK6(input as GraphDraftComposition, { mode: "diagnostic" }).errors.length).toBeGreaterThan(0);
  });
});
