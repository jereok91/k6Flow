import { describe, it, expect } from "vitest";
import {
  captureToNode,
  capturesToGraph,
  generateConnections,
  type CaptureGraphNode,
} from "./capture-to-graph";
import type { RecorderCaptureEntry } from "./recorder-contracts";

describe("captureToNode", () => {
  it("converts a simple GET request", () => {
    const entry: RecorderCaptureEntry = {
      method: "GET",
      url: "https://api.example.com/users",
      status: 200,
      headers: [{ name: "Accept", value: "application/json" }],
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.id).toBe("capture-0");
    expect(node.kind).toBe("http-request");
    expect(node.parameters.method).toBe("GET");
    expect(node.parameters.url).toEqual({ kind: "literal", value: "https://api.example.com/users" });
    expect(node.parameters.headers).toEqual([
      { name: "Accept", value: { kind: "literal", value: "application/json" } },
    ]);
    expect(node.meta.originalStatus).toBe(200);
    expect(node.meta.redacted).toBe(false);
  });

  it("converts a POST request with JSON body", () => {
    const entry: RecorderCaptureEntry = {
      method: "POST",
      url: "https://api.example.com/login",
      status: 200,
      headers: [
        { name: "Content-Type", value: "application/json" },
      ],
      bodyExcerpt: '{"username":"test","password":"secret"}',
      redacted: false,
    };

    const node = captureToNode(entry, 1);

    expect(node.parameters.method).toBe("POST");
    expect(node.parameters.body).toEqual({
      kind: "json",
      value: { kind: "literal", value: '{"username":"test","password":"secret"}' },
    });
  });

  it("converts a request with query parameters", () => {
    const entry: RecorderCaptureEntry = {
      method: "GET",
      url: "https://api.example.com/search?q=test&page=1",
      status: 200,
      headers: [],
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.parameters.url).toEqual({
      kind: "literal",
      value: "https://api.example.com/search",
    });
    expect(node.parameters.query).toEqual([
      { name: "q", value: { kind: "literal", value: "test" } },
      { name: "page", value: { kind: "literal", value: "1" } },
    ]);
  });

  it("excludes hop-by-hop headers", () => {
    const entry: RecorderCaptureEntry = {
      method: "GET",
      url: "https://example.com",
      status: 200,
      headers: [
        { name: "Connection", value: "keep-alive" },
        { name: "Host", value: "example.com" },
        { name: "Accept", value: "*/*" },
      ],
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.parameters.headers).toEqual([
      { name: "Accept", value: { kind: "literal", value: "*/*" } },
    ]);
  });

  it("handles custom id prefix", () => {
    const entry: RecorderCaptureEntry = {
      method: "GET",
      url: "https://example.com",
      status: 200,
      headers: [],
      redacted: false,
    };

    const node = captureToNode(entry, 5, { idPrefix: "req" });

    expect(node.id).toBe("req-5");
  });

  it("handles text body when Content-Type is not JSON", () => {
    const entry: RecorderCaptureEntry = {
      method: "POST",
      url: "https://example.com/form",
      status: 200,
      headers: [
        { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      ],
      bodyExcerpt: "name=test&value=123",
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.parameters.body).toEqual({
      kind: "text",
      value: { kind: "literal", value: "name=test&value=123" },
    });
  });

  it("ignores binary content in body", () => {
    const entry: RecorderCaptureEntry = {
      method: "POST",
      url: "https://example.com/upload",
      status: 200,
      headers: [],
      bodyExcerpt: "[binary content]",
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.parameters.body).toBeUndefined();
  });

  it("preserves redacted flag in metadata", () => {
    const entry: RecorderCaptureEntry = {
      method: "POST",
      url: "https://example.com/auth",
      status: 200,
      headers: [],
      redacted: true,
    };

    const node = captureToNode(entry, 0);

    expect(node.meta.redacted).toBe(true);
  });

  it("handles invalid JSON body as text", () => {
    const entry: RecorderCaptureEntry = {
      method: "POST",
      url: "https://example.com/api",
      status: 200,
      headers: [{ name: "Content-Type", value: "application/json" }],
      bodyExcerpt: "not valid json {",
      redacted: false,
    };

    const node = captureToNode(entry, 0);

    expect(node.parameters.body).toEqual({
      kind: "text",
      value: { kind: "literal", value: "not valid json {" },
    });
  });
});

describe("capturesToGraph", () => {
  it("converts multiple entries to nodes", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/1", status: 200, headers: [], redacted: false },
      { method: "GET", url: "https://example.com/2", status: 200, headers: [], redacted: false },
      { method: "GET", url: "https://example.com/3", status: 200, headers: [], redacted: false },
    ];

    const nodes = capturesToGraph(entries);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe("capture-0");
    expect(nodes[1].id).toBe("capture-1");
    expect(nodes[2].id).toBe("capture-2");
  });

  it("passes options to each node conversion", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com", status: 200, headers: [], redacted: false },
    ];

    const nodes = capturesToGraph(entries, { idPrefix: "imported" });

    expect(nodes[0].id).toBe("imported-0");
  });

  it("returns empty array for empty input", () => {
    const nodes = capturesToGraph([]);
    expect(nodes).toEqual([]);
  });
});

describe("generateConnections", () => {
  it("generates sequential connections", () => {
    const nodes: CaptureGraphNode[] = [
      { id: "n-0", kind: "http-request", references: {}, parameters: { method: "GET", url: { kind: "literal", value: "" } }, meta: { originalStatus: 200, redacted: false } },
      { id: "n-1", kind: "http-request", references: {}, parameters: { method: "GET", url: { kind: "literal", value: "" } }, meta: { originalStatus: 200, redacted: false } },
      { id: "n-2", kind: "http-request", references: {}, parameters: { method: "GET", url: { kind: "literal", value: "" } }, meta: { originalStatus: 200, redacted: false } },
    ];

    const connections = generateConnections(nodes);

    expect(connections).toEqual([
      { source: "n-0", target: "n-1" },
      { source: "n-1", target: "n-2" },
    ]);
  });

  it("returns empty array for single node", () => {
    const nodes: CaptureGraphNode[] = [
      { id: "n-0", kind: "http-request", references: {}, parameters: { method: "GET", url: { kind: "literal", value: "" } }, meta: { originalStatus: 200, redacted: false } },
    ];

    const connections = generateConnections(nodes);

    expect(connections).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    const connections = generateConnections([]);
    expect(connections).toEqual([]);
  });
});
