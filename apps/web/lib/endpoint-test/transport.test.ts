import { expect, it, vi } from "vitest";
import type { EndpointRequestOptions } from "./execute";
import {
  createNodeTransport,
  createPinnedLookup,
  type NodeRequestFactory,
  type NodeTransportDeps,
  type NodeTransportRequest,
  type NodeTransportRequestOptions,
  type NodeTransportResponse,
} from "./transport";

// Every test drives the transport through injected request factories, so no
// socket, DNS query or real connection is ever made. The fakes record the exact
// options the transport builds and let a test deliver a response or an error.
// `node:dns` is replaced with a spy so a test can prove the pinned lookup never
// falls back to a real resolver.

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

const encoder = new TextEncoder();

class FakeRequest implements NodeTransportRequest {
  readonly socket = { destroy: vi.fn((_error?: Error) => {}) };
  readonly end = vi.fn((_body?: string) => {});
  readonly destroy = vi.fn((_error?: Error) => {});
  private readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: string, listener: (error: Error) => void): this {
    if (event === "error") this.errorListeners.push(listener);
    return this;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface FactoryCall {
  readonly options: NodeTransportRequestOptions;
  readonly request: FakeRequest;
  respond(response: NodeTransportResponse): void;
  fail(error: Error): void;
}

function captureFactory(): { calls: FactoryCall[]; factory: NodeRequestFactory } {
  const calls: FactoryCall[] = [];
  const factory: NodeRequestFactory = (options, onResponse) => {
    const request = new FakeRequest();
    calls.push({ options, request, respond: onResponse, fail: error => request.emitError(error) });
    return request;
  };
  return { calls, factory };
}

function fakeResponse(
  statusCode: number,
  headers: Record<string, string | string[]> = {},
  chunks: string[] = [],
): NodeTransportResponse {
  return {
    statusCode,
    headers,
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
}

function harness(overrides: Partial<NodeTransportDeps> = {}) {
  const http = captureFactory();
  const https = captureFactory();
  const agentFactory = vi.fn((_protocol: "http:" | "https:") => ({ kind: "agent" }));
  const transport = createNodeTransport({
    httpRequest: http.factory,
    httpsRequest: https.factory,
    agentFactory,
    ...overrides,
  });
  return { transport, http, https, agentFactory };
}

function requestOptions(overrides: Partial<EndpointRequestOptions> = {}): EndpointRequestOptions {
  return {
    url: "https://api.example.test/path",
    method: "GET",
    headers: {},
    pinnedAddresses: ["93.184.216.34"],
    ...overrides,
  };
}

it("pins the lookup to the approved address for any requested hostname", () => {
  const lookup = createPinnedLookup(["93.184.216.34"]);
  const first = vi.fn();
  lookup("api.example.test", {}, first);
  expect(first).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  const second = vi.fn();
  lookup("a-completely-different.test", { all: false }, second);
  expect(second).toHaveBeenCalledWith(null, "93.184.216.34", 4);
});

it("uses the first usable pinned address and derives its family from the address", () => {
  const lookup = createPinnedLookup(["not-an-address", "2001:db8::1", "10.0.0.9"]);
  const callback = vi.fn();
  lookup("internal.svc", {}, callback);
  expect(callback).toHaveBeenCalledWith(null, "2001:db8::1", 6);
});

it("answers an all-addresses lookup with the single pinned address", () => {
  const lookup = createPinnedLookup(["10.0.0.9"]);
  const callback = vi.fn();
  lookup("internal.svc", { all: true }, callback);
  expect(callback).toHaveBeenCalledWith(null, [{ address: "10.0.0.9", family: 4 }]);
});

it("never consults a fallback resolver", () => {
  const lookup = createPinnedLookup(["93.184.216.34"]);
  const callback = vi.fn();
  lookup("host.test", {}, callback);
  expect(dnsLookup).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledTimes(1);
});

it("fails the lookup closed when there is no usable pinned address", () => {
  const lookup = createPinnedLookup([]);
  const callback = vi.fn();
  lookup("host.test", {}, callback);
  expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
});

it("refuses to start a request when no address is pinned", async () => {
  const h = harness();
  const { result } = h.transport.start(requestOptions({ pinnedAddresses: [] }));
  await expect(result).rejects.toBeInstanceOf(Error);
  expect(h.http.calls).toHaveLength(0);
  expect(h.https.calls).toHaveLength(0);
});

it("uses the https factory and keeps the original hostname as servername", () => {
  const h = harness();
  h.transport.start(requestOptions({ pinnedAddresses: ["93.184.216.34"] }));
  expect(h.https.calls).toHaveLength(1);
  expect(h.http.calls).toHaveLength(0);
  const { options } = h.https.calls[0];
  expect(options.servername).toBe("api.example.test");
  expect(options.servername).not.toBe("93.184.216.34");
  expect(options.hostname).toBe("api.example.test");
  expect(options.port).toBe(443);
  expect(options.protocol).toBe("https:");
  expect(h.agentFactory).toHaveBeenCalledWith("https:");
});

it("uses the http factory for an http URL and omits servername", () => {
  const h = harness();
  h.transport.start(requestOptions({ url: "http://internal.svc:8080/ping" }));
  expect(h.http.calls).toHaveLength(1);
  expect(h.https.calls).toHaveLength(0);
  const { options } = h.http.calls[0];
  expect(options.servername).toBeUndefined();
  expect(options.hostname).toBe("internal.svc");
  expect(options.port).toBe(8080);
  expect(options.protocol).toBe("http:");
  expect(h.agentFactory).toHaveBeenCalledWith("http:");
});

it("returns a 3xx response as-is and starts exactly one request", async () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  h.https.calls[0].respond(fakeResponse(302, { location: "https://elsewhere.test/" }));
  const response = await request.result;
  expect(response.status).toBe(302);
  expect(response.headers).toEqual({ location: "https://elsewhere.test/" });
  expect(h.https.calls).toHaveLength(1);
});

it("returns the response body as an async byte stream", async () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  h.https.calls[0].respond(fakeResponse(200, { "content-type": "text/plain" }, ["he", "llo"]));
  const response = await request.result;
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toBe("text/plain");
  const chunks: string[] = [];
  for await (const chunk of response.body!) chunks.push(new TextDecoder().decode(chunk));
  expect(chunks.join("")).toBe("hello");
});

it("abort destroys the request and its socket", () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  request.abort();
  expect(h.https.calls[0].request.destroy).toHaveBeenCalledTimes(1);
  expect(h.https.calls[0].request.socket.destroy).toHaveBeenCalledTimes(1);
});

it("forwards headers and body with a byte-accurate content-length", () => {
  const h = harness();
  h.transport.start(requestOptions({
    url: "http://internal.svc:8080/submit",
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "héllo",
  }));
  const { options, request } = h.http.calls[0];
  expect(options.headers["content-type"]).toBe("text/plain");
  expect(options.headers["content-length"]).toBe("6");
  expect(options.method).toBe("POST");
  expect(options.path).toBe("/submit");
  expect(request.end).toHaveBeenCalledWith("héllo");
});

it("adds no content-length for a body-less request", () => {
  const h = harness();
  h.transport.start(requestOptions());
  const { options, request } = h.https.calls[0];
  expect(options.headers).toEqual({});
  expect(request.end).toHaveBeenCalledTimes(1);
});

it("rejects the result when the request errors", async () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  h.https.calls[0].fail(new Error("boom"));
  await expect(request.result).rejects.toThrow("boom");
});

it("does not retry after a request error", async () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  h.https.calls[0].fail(new Error("boom"));
  await expect(request.result).rejects.toThrow("boom");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.https.calls).toHaveLength(1);
});

it("does not mutate the caller's headers when adding content-length", () => {
  const h = harness();
  const headers = Object.freeze({ "content-type": "text/plain" });
  h.transport.start(requestOptions({ method: "POST", headers, body: "x" }));
  expect(h.https.calls[0].options.headers).toEqual({
    "content-type": "text/plain",
    "content-length": "1",
  });
  expect(headers).toEqual({ "content-type": "text/plain" });
});

it("uses a non-pooling agent by default so a pooled socket cannot bypass the pin", () => {
  const http = captureFactory();
  const https = captureFactory();
  const transport = createNodeTransport({ httpRequest: http.factory, httpsRequest: https.factory });
  transport.start(requestOptions());
  expect(https.calls[0].options.agent).toBe(false);
});

it("joins repeated response headers into a single value", async () => {
  const h = harness();
  const request = h.transport.start(requestOptions());
  h.https.calls[0].respond(fakeResponse(200, { "set-cookie": ["a=1", "b=2"] }));
  const response = await request.result;
  expect(response.headers["set-cookie"]).toBe("a=1, b=2");
});
