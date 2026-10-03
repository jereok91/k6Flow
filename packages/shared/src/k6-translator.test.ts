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
    expect(result.script).toContain("const pool_1_data = new SharedArray('users'");
    expect(result.script).toContain("open('./users.csv')");
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
