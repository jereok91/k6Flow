import { expect, it, vi } from "vitest";
import {
  ENDPOINT_BODY_LIMIT,
  executeEndpointTest,
  type EndpointIo,
  type EndpointRequestOptions,
  type EndpointResponse,
} from "./execute";

const ALLOW = "api.example.test:443, internal.svc:8080";
const encoder = new TextEncoder();

async function* stream(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

async function* stalled(): AsyncIterable<Uint8Array> {
  await new Promise(() => {});
}

function ok(overrides: Partial<EndpointResponse> = {}): EndpointResponse {
  return { status: 200, headers: {}, body: stream("hello"), ...overrides };
}

function harness(
  response?: EndpointResponse,
  options: { addresses?: readonly string[]; resolve?: () => Promise<readonly string[]>; reject?: unknown } = {},
) {
  let fire: (() => void) | null = null;
  let tick = 0;
  const abort = vi.fn();
  const resolve = vi.fn(options.resolve ?? (async () => options.addresses ?? ["93.184.216.34"]));
  const start = vi.fn((_options: EndpointRequestOptions) => ({
    result: options.reject === undefined
      ? Promise.resolve(response!)
      : Promise.resolve().then(() => { throw options.reject; }),
    abort,
  }));
  const clearTimer = vi.fn();
  const io: EndpointIo = {
    resolve,
    transport: { start },
    now: () => tick++,
    setTimer: (callback: () => void) => {
      fire = callback;
      return "handle";
    },
    clearTimer,
  };
  return { io, resolve, start, abort, fireTimer: () => fire?.(), cleared: () => clearTimer.mock.calls.length > 0 };
}

const base = { url: "https://api.example.test/path", method: "GET", allowList: ALLOW };

it("denies an unlisted host before resolving or connecting", async () => {
  const h = harness(ok());
  expect(await executeEndpointTest({ ...base, url: "https://other.example.test/" }, h.io)).toEqual({
    kind: "denied", reason: "host-not-allowed",
  });
  expect(h.resolve).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});

it.each([
  ["ftp://api.example.test/", "scheme"],
  ["https://user:pass@api.example.test/", "credentials"],
  ["https://api.example.test:8443/", "port-not-allowed"],
])("denies %s as %s before any io", async (url, reason) => {
  const h = harness(ok());
  expect(await executeEndpointTest({ ...base, url }, h.io)).toEqual({ kind: "denied", reason });
  expect(h.resolve).not.toHaveBeenCalled();
});

it("denies a malformed allow-list without contacting anything", async () => {
  const h = harness(ok());
  expect(await executeEndpointTest({ ...base, allowList: "api.example.test" }, h.io)).toEqual({
    kind: "denied", reason: "malformed-config",
  });
  expect(h.resolve).not.toHaveBeenCalled();
});

it("denies a listed host that resolves to loopback without connecting", async () => {
  const h = harness(ok(), { addresses: ["127.0.0.1"] });
  expect(await executeEndpointTest({ ...base, url: "http://internal.svc:8080/" }, h.io)).toEqual({
    kind: "denied", reason: "address-denied",
  });
  expect(h.start).not.toHaveBeenCalled();
});

it.each(["DELETE", "TRACE", "OPTIONS"])("rejects the method %s before any io", async method => {
  const h = harness(ok());
  expect(await executeEndpointTest({ ...base, method }, h.io)).toEqual({
    kind: "invalid-input", reason: "method-not-allowed",
  });
  expect(h.resolve).not.toHaveBeenCalled();
});

it("rejects an oversized request body before any io", async () => {
  const h = harness(ok());
  expect(await executeEndpointTest({ ...base, method: "POST", bodyText: "a".repeat(ENDPOINT_BODY_LIMIT + 1) }, h.io))
    .toEqual({ kind: "invalid-input", reason: "body-too-large" });
  expect(h.resolve).not.toHaveBeenCalled();
});

it("pins the connection to an approved address and keeps the original hostname", async () => {
  const h = harness(ok());
  await executeEndpointTest({ ...base, method: "POST", bodyText: "{}", headers: [{ name: "accept", value: "application/json" }] }, h.io);
  const options = h.start.mock.calls[0][0];
  expect(options.pinnedAddresses).toEqual(["93.184.216.34"]);
  expect(options.url).toBe("https://api.example.test/path");
  expect(options.method).toBe("POST");
  expect(options.headers).toEqual({ accept: "application/json" });
  expect(options.body).toBe("{}");
});

it("returns a redirect without following it", async () => {
  const h = harness(ok({ status: 302, headers: { location: "https://other.example.test/" } }));
  expect(await executeEndpointTest(base, h.io)).toMatchObject({ kind: "ok", status: 302 });
  expect(h.start).toHaveBeenCalledTimes(1);
});

it("times out a stalled resolution and clears its timer", async () => {
  const h = harness(ok(), { resolve: () => new Promise(() => {}) });
  const pending = executeEndpointTest(base, h.io);
  h.fireTimer();
  expect(await pending).toEqual({ kind: "timeout" });
  expect(h.cleared()).toBe(true);
});

it("aborts the transport when the deadline fires while reading the body", async () => {
  const h = harness(ok({ body: stalled() }));
  const pending = executeEndpointTest(base, h.io);
  // Flush the whole microtask chain so the transport is started before the timer.
  await new Promise(resolve => setTimeout(resolve, 0));
  h.fireTimer();
  expect(await pending).toEqual({ kind: "timeout" });
  expect(h.abort).toHaveBeenCalledTimes(1);
});

it("cuts a large response and reports truncation", async () => {
  const h = harness(ok({ body: stream("x".repeat(40_000), "y".repeat(40_000)) }));
  const result = await executeEndpointTest(base, h.io);
  expect(result).toMatchObject({ kind: "ok", truncated: true });
  if (result.kind === "ok") expect(result.bodyText.length).toBe(ENDPOINT_BODY_LIMIT);
});

it("does not report truncation for a response within the limit", async () => {
  const h = harness(ok({ body: stream("small") }));
  expect(await executeEndpointTest(base, h.io)).toMatchObject({ kind: "ok", truncated: false, bodyText: "small" });
});

it("masks sensitive response headers and secret values in the body", async () => {
  const h = harness(ok({
    headers: { "set-cookie": "session=abc123", "content-type": "application/json", authorization: "Bearer abc123" },
    body: stream('{"token":"s3cr3t-value"}'),
  }));
  const result = await executeEndpointTest({ ...base, secretValues: ["s3cr3t-value", "abc123"] }, h.io);
  expect(result).toMatchObject({ kind: "ok" });
  if (result.kind !== "ok") return;
  expect(result.headers).toContainEqual({ name: "set-cookie", value: "[REDACTED]" });
  expect(result.headers).toContainEqual({ name: "authorization", value: "[REDACTED]" });
  expect(result.headers).toContainEqual({ name: "content-type", value: "application/json" });
  expect(result.bodyText).not.toContain("s3cr3t-value");
  expect(JSON.stringify(result)).not.toContain("abc123");
});

it("reports a generic network failure without upstream text", async () => {
  const h = harness(undefined, { reject: new Error("ECONNREFUSED 10.0.0.1 secret-token") });
  const result = await executeEndpointTest({ ...base, secretValues: ["secret-token"] }, h.io);
  expect(result).toEqual({ kind: "network" });
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

it("reports a failing resolver as network, not as a denial", async () => {
  const h = harness(ok(), { resolve: () => Promise.reject(new Error("ENOTFOUND")) });
  expect(await executeEndpointTest(base, h.io)).toEqual({ kind: "network" });
  expect(h.start).not.toHaveBeenCalled();
});

it("masks the longest overlapping secret first", async () => {
  const h = harness(ok({ body: stream("value abcd end") }));
  const result = await executeEndpointTest({ ...base, secretValues: ["abc", "abcd"] }, h.io);
  expect(result).toMatchObject({ kind: "ok" });
  if (result.kind !== "ok") return;
  expect(result.bodyText).not.toContain("abcd");
  expect(result.bodyText).not.toContain("[REDACTED]d");
  expect(result.bodyText).toContain("[REDACTED]");
});

it("does not leak any prefix of a secret that straddles the truncation boundary", async () => {
  const secret = "ZQSECRETZQ";
  // The secret starts three bytes before the cap, so a naive cut keeps "ZQS".
  const h = harness(ok({ body: stream("x".repeat(ENDPOINT_BODY_LIMIT - 3), secret) }));
  const result = await executeEndpointTest({ ...base, secretValues: [secret] }, h.io);
  expect(result).toMatchObject({ kind: "ok", truncated: true });
  if (result.kind !== "ok") return;
  expect(result.bodyText.length).toBe(ENDPOINT_BODY_LIMIT);
  const leaked = ["ZQSECRETZQ", "ZQSECRETZ", "ZQSECRET", "ZQSECRE", "ZQSECR", "ZQSEC", "ZQSE", "ZQS"]
    .some(prefix => result.bodyText.includes(prefix));
  expect(leaked).toBe(false);
});

it("never sends the request when resolution completes after the deadline", async () => {
  let release!: (addresses: readonly string[]) => void;
  const h = harness(ok(), { resolve: () => new Promise(resolve => { release = resolve; }) });
  const pending = executeEndpointTest(base, h.io);
  h.fireTimer();
  expect(await pending).toEqual({ kind: "timeout" });
  release(["93.184.216.34"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.start).not.toHaveBeenCalled();
});

it("never echoes the request headers or the raw response", async () => {
  const h = harness(ok({ headers: { "x-request-id": "abc" } }));
  const result = await executeEndpointTest({
    ...base, headers: [{ name: "authorization", value: "Bearer super-secret" }], secretValues: ["super-secret"],
  }, h.io);
  expect(JSON.stringify(result)).not.toContain("super-secret");
  expect(JSON.stringify(result)).not.toContain("Bearer");
});
