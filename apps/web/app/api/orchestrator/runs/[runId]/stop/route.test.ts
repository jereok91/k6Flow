import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ user: vi.fn(), identity: vi.fn(), owner: vi.fn(), owns: vi.fn() }));
vi.mock("../../../../../../lib/auth/require-user", () => ({ requireUser: mocks.user, requireSessionIdentity: mocks.identity }));
vi.mock("../../../../../../lib/editor/run-ownership", () => ({ getRunOwner: mocks.owner, isRunOwner: mocks.owns }));
import { POST } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const LIVE = "a".repeat(64);
const OTHER = "b".repeat(64);
const user = { id: "user" };
const request = (marker?: string) => new NextRequest("http://localhost/api/orchestrator/runs/run%2Fa/stop", {
  method: "POST",
  headers: { cookie: COOKIE, ...(marker !== undefined && { "X-K6Flow-Session-Marker": marker }) },
});
const context = { params: Promise.resolve({ runId: "run/a" }) };
const expectNoSecrets = (text: string) => {
  for (const secret of [LIVE, OTHER, "cookie-secret-token"]) expect(text).not.toContain(secret);
};

describe("run stop proxy session binding", () => {
  beforeEach(() => {
    mocks.user.mockResolvedValue(user);
    mocks.identity.mockResolvedValue({ user, sessionMarker: LIVE });
    mocks.owner.mockResolvedValue({ userId: "user" });
    mocks.owns.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ status: "stopping" })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards a load stop without a marker unchanged", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expectNoSecrets(await response.text());
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.owns).toHaveBeenCalledWith("run/a", "user");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps load stop denials unchanged", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(401);
    mocks.owns.mockResolvedValueOnce(false);
    expect((await POST(request(), context)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([["malformed", "A".repeat(64)], ["mismatched", OTHER]])(
    "rejects a %s marker before ownership or forwarding", async (_kind, marker) => {
      const response = await POST(request(marker), context);
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Session changed" });
      expectNoSecrets(text);
      expect(mocks.owner).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

  it("returns a generic 503 when the marked session lookup throws", async () => {
    mocks.identity.mockRejectedValue(new Error(`Failed query\nparams: cookie-secret-token,${LIVE}`));
    const response = await POST(request(LIVE), context);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Session check unavailable" });
    expectNoSecrets(text);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards an owned stop whose marker matches, encoding the run ID", async () => {
    const response = await POST(request(LIVE), context);
    expect(response.status).toBe(200);
    expectNoSecrets(await response.text());
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.owns).toHaveBeenCalledWith("run/a", "user");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/runs/run%2Fa/stop"), expect.objectContaining({ method: "POST" }));
  });

  it("denies a matching marker for a non-owner", async () => {
    mocks.owns.mockResolvedValue(false);
    const response = await POST(request(LIVE), context);
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leak a thrown ownership lookup on the marker path", async () => {
    mocks.owner.mockRejectedValueOnce(new Error(`secret-db ${LIVE}`));
    const response = await POST(request(LIVE), context);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("secret");
    expectNoSecrets(text);
    expect(fetch).not.toHaveBeenCalled();
  });
});
