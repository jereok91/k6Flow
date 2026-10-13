import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ identity: vi.fn(), owner: vi.fn(), owns: vi.fn() }));
vi.mock("../../../../../../lib/auth/require-user", () => ({ requireSessionIdentity: mocks.identity }));
vi.mock("../../../../../../lib/editor/run-ownership", () => ({ getRunOwner: mocks.owner, isRunOwner: mocks.owns }));
import { GET } from "./route";

const snapshot = {
  version: 1, runId: "run/a", status: "pending",
  diagnostic: { nodeIds: ["a"] }, trace: { state: "pending", events: [] },
};
const COOKIE = "k6flow_session=cookie-secret-token";
const LIVE = "a".repeat(64);
const OTHER = "b".repeat(64);
const request = (marker: string | null = LIVE) => new NextRequest("http://localhost/api/orchestrator/runs/run%2Fa/diagnostic", {
  headers: { cookie: COOKIE, ...(marker !== null && { "X-K6Flow-Session-Marker": marker }) },
});
const live = (marker: string) => ({ user: { id: "user" }, sessionMarker: marker });
const expectNoSecrets = (text: string) => {
  for (const secret of [LIVE, OTHER, "cookie-secret-token"]) expect(text).not.toContain(secret);
};
const context = { params: Promise.resolve({ runId: "run/a" }) };

describe("owned diagnostic proxy", () => {
  beforeEach(() => {
    mocks.identity.mockResolvedValue(live(LIVE));
    mocks.owner.mockResolvedValue("user");
    mocks.owns.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("requires session before ownership/fetch", async () => {
    mocks.identity.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoSecrets(await response.text());
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([["missing", null], ["malformed", "A".repeat(64)], ["mismatched", OTHER]])(
    "rejects a %s session marker before ownership/fetch", async (_kind, marker) => {
      const response = await GET(request(marker), context);
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Session changed" });
      expectNoSecrets(text);
      expect(mocks.owner).not.toHaveBeenCalled();
      expect(mocks.owns).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  it("returns a generic 503 when the session lookup throws", async () => {
    mocks.identity.mockRejectedValue(new Error(`Failed query\nparams: cookie-secret-token,${LIVE}`));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Session check unavailable" });
    expectNoSecrets(text);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("withholds the snapshot when the session re-check throws", async () => {
    mocks.identity.mockResolvedValueOnce(live(LIVE)).mockRejectedValueOnce(new Error("cookie-secret-token"));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("nodeIds");
    expectNoSecrets(text);
  });
  it.each([["changed", live(OTHER), 409], ["ended", null, 401]])(
    "withholds the snapshot when the session %s during the upstream read", async (_kind, next, status) => {
      mocks.identity.mockResolvedValueOnce(live(LIVE)).mockResolvedValueOnce(next);
      const response = await GET(request(), context);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain("nodeIds");
      expectNoSecrets(text);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each(["unknown", "other"])("denies %s ownership before fetch", async kind => {
    if (kind === "unknown") mocks.owner.mockResolvedValue(null);
    else mocks.owns.mockResolvedValue(false);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expectNoSecrets(await response.text());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("encodes IDs and disables caching", async () => {
    const response = await GET(request(), context);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(snapshot);
    expectNoSecrets(text);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.identity).toHaveBeenCalledTimes(2);
    expect(mocks.owns).toHaveBeenCalledWith("run/a", "user");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("run%2Fa/diagnostic"), expect.objectContaining({
      cache: "no-store", signal: expect.any(AbortSignal),
    }));
  });
  it.each([404, 409, 500])("sanitizes upstream %s", async status => {
    vi.mocked(fetch).mockResolvedValue(new Response("secret-url-exception", { status }));
    const response = await GET(request(), context);
    expect(response.status).toBe(status === 500 ? 502 : status);
    expect(await response.text()).not.toContain("secret");
  });
  it("does not expose fetch exception", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret-token"));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });
  it("does not fetch after ownership lookup fails", async () => {
    mocks.owner.mockRejectedValueOnce(new Error("secret-db"));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
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
  it("bounds snapshot response bytes", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("x".repeat(128 * 1024 + 1)));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("xxx");
  });
  it("rejects unsafe upstream points", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      ...snapshot, trace: { state: "running", events: [{ url: "secret" }] },
    }));
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });
});
