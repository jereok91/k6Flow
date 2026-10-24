import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ identity: vi.fn(), owner: vi.fn(), owns: vi.fn() }));
vi.mock("../../../../../../lib/auth/require-user", () => ({ requireSessionIdentity: mocks.identity }));
vi.mock("../../../../../../lib/editor/run-ownership", () => ({ getRunOwner: mocks.owner, isRunOwner: mocks.owns }));
import { GET } from "./route";

const frame = {
  version: 1, type: "metrics", runId: "run/a", seq: 2,
  window: { startMs: 2000, durationMs: 1000 },
  reqPerSec: 12.5, latencyMs: { avg: 45.5, p90: 60, p95: 88.25, p99: 120 },
  httpFailureFraction: 0.25, activeVUs: 11, failedChecks: 2,
};
const COOKIE = "k6flow_session=cookie-secret-token";
const LIVE = "a".repeat(64);
const OTHER = "b".repeat(64);
const request = (marker: string | null = LIVE) => new NextRequest("http://localhost/api/orchestrator/runs/run%2Fa/metrics", {
  headers: { cookie: COOKIE, ...(marker !== null && { "X-K6Flow-Session-Marker": marker }) },
});
const live = (marker: string) => ({ user: { id: "user" }, sessionMarker: marker });
const expectNoSecrets = (text: string) => {
  for (const secret of [LIVE, OTHER, "cookie-secret-token"]) expect(text).not.toContain(secret);
};
const context = { params: Promise.resolve({ runId: "run/a" }) };

describe("owned metrics proxy", () => {
  beforeEach(() => {
    mocks.identity.mockResolvedValue(live(LIVE));
    mocks.owner.mockResolvedValue("user");
    mocks.owns.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(frame)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("requires a session before ownership or fetch", async () => {
    mocks.identity.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoSecrets(await response.text());
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a session marker that no longer matches", async () => {
    const response = await GET(request(OTHER), context);
    expect(response.status).toBe(412);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoSecrets(await response.text());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["unknown", "other"])("denies %s ownership before fetch", async kind => {
    if (kind === "unknown") mocks.owner.mockResolvedValue(null);
    else mocks.owns.mockResolvedValue(false);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expectNoSecrets(await response.text());
    expect(fetch).not.toHaveBeenCalled();
  });

  // The browser must receive the orchestrator's frame untouched: this is the
  // same shape the WS `tick` frame carries.
  it("passes the frame through unchanged with no-store", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual(frame);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("run%2Fa/metrics"), expect.objectContaining({
      cache: "no-store", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer ") }),
    }));
    expect(mocks.owns).toHaveBeenCalledWith("run/a", "user");
  });

  // No snapshot yet: the panel treats 404 as "keep polling status only".
  it("maps an upstream 404 to a silent no-snapshot 404", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("secret-upstream-body", { status: 404 }));
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Metrics unavailable" });
    expect(text).not.toContain("secret");
  });

  it.each([409, 500])("sanitizes upstream %s as 502", async status => {
    vi.mocked(fetch).mockResolvedValue(new Response("secret-upstream-body", { status }));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });

  it("does not expose fetch exceptions", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret-token"));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });

  // Never invent a shape: a frame outside the shared contract is a bad gateway.
  it.each([
    ["missing fields", { version: 1, type: "metrics", runId: "run/a" }],
    ["extra fields", { ...frame, extra: true }],
    ["wrong run", { ...frame, runId: "other-run" }],
    ["inconsistent samples", { ...frame, reqPerSec: null }],
  ])("rejects an invalid upstream frame (%s)", async (_kind, body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("reqPerSec");
  });

  it("bounds the upstream response bytes", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("x".repeat(8 * 1024 + 1)));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("xxx");
  });

  it("times out without exposing details", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("secret")));
    }));
    const pending = GET(request(), context);
    await vi.advanceTimersByTimeAsync(5001);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.text()).not.toContain("secret");
  });

  it("withholds the frame when the session changes during the upstream read", async () => {
    mocks.identity.mockResolvedValueOnce(live(LIVE)).mockResolvedValueOnce(live(OTHER));
    const response = await GET(request(), context);
    expect(response.status).toBe(412);
    expect(await response.text()).not.toContain("reqPerSec");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
