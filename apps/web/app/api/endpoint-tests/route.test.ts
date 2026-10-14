import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route is exercised end to end: the executor is wrapped (not replaced) so
// the real allow-list pass and the real masking run, while DNS and the transport
// are injected fakes. No test opens a socket, resolves DNS or touches the DB.
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  checkExpectedSession: vi.fn(),
  resolve: vi.fn(),
  lookup: vi.fn(),
  transportStart: vi.fn(),
}));

vi.mock("../../../lib/auth/require-user", () => ({
  requireUser: mocks.requireUser,
  requireSessionIdentity: vi.fn(),
}));

vi.mock("../../../lib/auth/expected-session", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/auth/expected-session")>();
  return { ...actual, checkExpectedSession: mocks.checkExpectedSession };
});

// Keep the real storeFailureResponse so the tests exercise the repository's
// actual status mapping; only the DB-backed resolver is replaced.
vi.mock("../../../lib/variables/store", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/variables/store")>()),
  resolveVariablesForRun: mocks.resolve,
}));

vi.mock("../../../lib/endpoint-test/execute", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../lib/endpoint-test/execute")>();
  return { ...actual, executeEndpointTest: vi.fn(actual.executeEndpointTest) };
});

vi.mock("../../../lib/endpoint-test/transport", () => ({
  createNodeTransport: vi.fn(() => ({ start: mocks.transportStart })),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

import { executeEndpointTest } from "../../../lib/endpoint-test/execute";
import { createNodeTransport } from "../../../lib/endpoint-test/transport";
import { POST } from "./route";

const ORIGINAL_ALLOWED = process.env.ENDPOINT_TEST_ALLOWED_TARGETS;
const COOKIE = "k6flow_session=cookie-secret-token";
const SECRET = "s3cr3t-token-value";
const PUBLIC_ADDRESS = "93.184.216.34";

function fakeResponse(status: number, headers: Record<string, string>, body: string) {
  return {
    status,
    headers,
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  };
}

const okParameters = {
  method: "GET",
  url: { kind: "literal", value: `https://api.example.test/{{TOKEN}}` },
  headers: [],
  body: { kind: "none" },
};

function post(rawBody: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/endpoint-tests", {
    method: "POST",
    body: rawBody,
    headers: { cookie: COOKIE, ...headers },
  });
}

const okRequest = () => post(JSON.stringify({ parameters: okParameters }));

function expectNoSecret(text: string) {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET.toUpperCase());
  expect(text).not.toContain("cookie-secret-token");
}

beforeEach(() => {
  process.env.ENDPOINT_TEST_ALLOWED_TARGETS = "api.example.test:443";
  mocks.requireUser.mockResolvedValue({ id: "user", role: "user" });
  mocks.checkExpectedSession.mockResolvedValue({
    ok: true,
    identity: { user: { id: "user" }, sessionMarker: "a".repeat(64) },
  });
  mocks.resolve.mockResolvedValue({
    ok: true,
    value: [{ name: "TOKEN", value: SECRET, secret: true }],
  });
  mocks.lookup.mockResolvedValue([{ address: PUBLIC_ADDRESS, family: 4 }]);
  mocks.transportStart.mockReturnValue({
    result: Promise.resolve(fakeResponse(200, { authorization: SECRET }, `echo:${SECRET}`)),
    abort: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  if (ORIGINAL_ALLOWED === undefined) delete process.env.ENDPOINT_TEST_ALLOWED_TARGETS;
  else process.env.ENDPOINT_TEST_ALLOWED_TARGETS = ORIGINAL_ALLOWED;
});

describe("POST /api/endpoint-tests", () => {
  it("returns 401 and never checks the session or the body without a user", async () => {
    mocks.requireUser.mockResolvedValue(null);
    const response = await POST(okRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.checkExpectedSession).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("returns 412 on a marker mismatch and never parses the body first", async () => {
    mocks.checkExpectedSession.mockResolvedValue({ ok: false, status: 412 });
    const response = await POST(post("{ this is not json"));
    expect(response.status).toBe(412);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Session changed" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("maps a 503 session-check failure to its fixed body", async () => {
    mocks.checkExpectedSession.mockResolvedValue({ ok: false, status: 503 });
    const response = await POST(okRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session check unavailable" });
  });

  it("rejects malformed JSON with a fixed 400 body", async () => {
    const response = await POST(post("{ not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("rejects an unexpected body key with a fixed 400 body", async () => {
    const response = await POST(post(JSON.stringify({ parameters: okParameters, secret: "nope" })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });

  it("maps a preparation failure to a 400 carrying only the reason code", async () => {
    const parameters = { ...okParameters, url: { kind: "literal", value: "https://api.example.test/{{NOPE}}" } };
    const response = await POST(post(JSON.stringify({ parameters })));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({ error: "Invalid endpoint request", reason: "unknown-variable" });
    expectNoSecret(JSON.stringify(json));
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.transportStart).not.toHaveBeenCalled();
  });

  it.each([
    ["forbidden", 403, "Forbidden"],
    ["not-found", 404, "Variables not found"],
  ])("maps a %s variable resolution failure with the store convention (%s) and echoes no id", async (reason, status, error) => {
    mocks.resolve.mockResolvedValue({ ok: false, reason });
    const response = await POST(post(JSON.stringify({ parameters: okParameters, scenarioId: "s1", environmentId: "e1" })));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(JSON.parse(text).error).toBe(error);
    expect(text).not.toContain("s1");
    expect(text).not.toContain("e1");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["malformed", "not-a-target"],
  ])("denies every target when the allow-list is %s", async (_label, allowed) => {
    process.env.ENDPOINT_TEST_ALLOWED_TARGETS = allowed;
    const response = await POST(okRequest());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.kind).toBe("denied");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.transportStart).not.toHaveBeenCalled();
  });

  it("denies a listed host that resolves to a non-unicast address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const response = await POST(okRequest());
    expect(response.status).toBe(403);
    expect((await response.json()).kind).toBe("denied");
    expect(mocks.transportStart).not.toHaveBeenCalled();
  });

  it("returns the ok result with no-store and no secret anywhere", async () => {
    const response = await POST(okRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.kind).toBe("ok");
    expect(json.status).toBe(200);
    expect(json.bodyText).toBe("echo:[REDACTED]");
    expect(json.headers).toEqual([{ name: "authorization", value: "[REDACTED]" }]);
    expectNoSecret(JSON.stringify(json));
  });

  it("wires the executor io to the node resolver and the node transport", async () => {
    mocks.lookup.mockResolvedValue([
      { address: PUBLIC_ADDRESS, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    await POST(okRequest());
    expect(mocks.lookup).toHaveBeenCalledWith("api.example.test", { all: true });
    expect(createNodeTransport).toHaveBeenCalledTimes(1);
    const io = vi.mocked(executeEndpointTest).mock.calls[0][1];
    expect(io.transport).toBeDefined();
    for (const fn of [io.resolve, io.now, io.setTimer, io.clearTimer]) expect(typeof fn).toBe("function");
    await expect(io.resolve("other.test")).resolves.toEqual([PUBLIC_ADDRESS, "2606:4700:4700::1111"]);
  });

  it("maps a timeout to 504", async () => {
    vi.useFakeTimers();
    mocks.transportStart.mockReturnValue({ result: new Promise(() => {}), abort: vi.fn() });
    const pending = POST(okRequest());
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Endpoint timed out" });
    expectNoSecret(text);
  });

  it("maps a network failure to 502", async () => {
    mocks.transportStart.mockReturnValue({ result: Promise.reject(new Error("boom")), abort: vi.fn() });
    const response = await POST(okRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Endpoint unreachable" });
  });

  it("rejects a request body larger than the documented cap", async () => {
    const huge = `{"parameters":{},"samples":{"x":"${"a".repeat(70_000)}"}}`;
    const response = await POST(post(huge));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
