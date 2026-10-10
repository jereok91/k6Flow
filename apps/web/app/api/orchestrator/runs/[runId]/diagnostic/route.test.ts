import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ user: vi.fn(), owner: vi.fn(), owns: vi.fn() }));
vi.mock("../../../../../../lib/auth/require-user", () => ({ requireUser: mocks.user }));
vi.mock("../../../../../../lib/editor/run-ownership", () => ({ getRunOwner: mocks.owner, isRunOwner: mocks.owns }));
import { GET } from "./route";

const snapshot = {
  version: 1, runId: "run/a", status: "pending",
  diagnostic: { nodeIds: ["a"] }, trace: { state: "pending", events: [] },
};
const request = () => new NextRequest("http://localhost/api/orchestrator/runs/run%2Fa/diagnostic");
const context = { params: Promise.resolve({ runId: "run/a" }) };

describe("owned diagnostic proxy", () => {
  beforeEach(() => {
    mocks.user.mockResolvedValue({ id: "user" });
    mocks.owner.mockResolvedValue({ userId: "user" });
    mocks.owns.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("requires session before ownership/fetch", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(401);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["unknown", "other"])("denies %s ownership before fetch", async kind => {
    if (kind === "unknown") mocks.owner.mockResolvedValue(null);
    else mocks.owns.mockResolvedValue(false);
    expect((await GET(request(), context)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("encodes IDs and disables caching", async () => {
    const response = await GET(request(), context);
    expect(await response.json()).toEqual(snapshot);
    expect(response.headers.get("cache-control")).toBe("no-store");
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
