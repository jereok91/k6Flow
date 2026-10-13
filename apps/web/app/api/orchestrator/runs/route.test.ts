import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), identity: vi.fn(), prepare: vi.fn(), setOwner: vi.fn(), clearOwner: vi.fn(),
}));
vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.user, requireSessionIdentity: mocks.identity }));
vi.mock("../../../../lib/editor/run-ownership", () => ({ setRunOwner: mocks.setOwner, clearRunOwner: mocks.clearOwner }));
vi.mock("../../../../lib/variables/store", () => ({ resolveVariablesForRun: vi.fn() }));
vi.mock("./run-env", () => ({ prepareRunStart: mocks.prepare }));
import { POST } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const LIVE = "a".repeat(64);
const OTHER = "b".repeat(64);
const user = { id: "user" };
const request = (body: Record<string, unknown>, marker?: string) => new NextRequest("http://localhost/api/orchestrator/runs", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { cookie: COOKIE, ...(marker !== undefined && { "X-K6Flow-Session-Marker": marker }) },
});
const expectNoSecrets = (text: string) => {
  for (const secret of [LIVE, OTHER, "cookie-secret-token"]) expect(text).not.toContain(secret);
};

describe("run start proxy session binding", () => {
  beforeEach(() => {
    mocks.user.mockResolvedValue(user);
    mocks.identity.mockResolvedValue({ user, sessionMarker: LIVE });
    mocks.prepare.mockImplementation(async (body: Record<string, unknown>) => ({ ok: true, orchestratorBody: body }));
    mocks.setOwner.mockResolvedValue(undefined);
    mocks.clearOwner.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ runId: "run-1" }, { status: 201 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([["missing", undefined], ["malformed", "A".repeat(64)], ["mismatched", OTHER]])(
    "rejects a diagnostic start with a %s marker before preparing or forwarding", async (_kind, marker) => {
      const response = await POST(request({ mode: "diagnostic", scenarioId: "s" }, marker));
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Session changed" });
      expectNoSecrets(text);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.setOwner).not.toHaveBeenCalled();
    });

  it("returns a generic 503 when the diagnostic session lookup throws", async () => {
    mocks.identity.mockRejectedValue(new Error(`Failed query\nparams: cookie-secret-token,${LIVE}`));
    const response = await POST(request({ mode: "diagnostic", scenarioId: "s" }, LIVE));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Session check unavailable" });
    expectNoSecrets(text);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.setOwner).not.toHaveBeenCalled();
  });

  it("forwards a diagnostic start whose marker matches the live session", async () => {
    const response = await POST(request({ mode: "diagnostic", scenarioId: "s" }, LIVE));
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ runId: "run-1" });
    expectNoSecrets(text);
    expect(mocks.prepare).toHaveBeenCalledWith({ mode: "diagnostic", scenarioId: "s" }, user, expect.any(Function));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.setOwner).toHaveBeenCalledWith("run-1", "user", expect.objectContaining({ scenarioId: "s" }));
  });

  it.each([["no mode", {}], ["load mode", { mode: "load" }]])(
    "forwards a %s start without a marker unchanged", async (_kind, extra) => {
      const response = await POST(request({ scenarioId: "s", ...extra }));
      expect(response.status).toBe(201);
      expectNoSecrets(await response.text());
      expect(mocks.identity).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mocks.setOwner).toHaveBeenCalledWith("run-1", "user", expect.objectContaining({ scenarioId: "s" }));
    });

  it("keeps load start statuses unchanged", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await POST(request({}))).status).toBe(401);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad", { status: 400 }));
    expect((await POST(request({}))).status).toBe(400);
    mocks.prepare.mockResolvedValueOnce({ ok: false, status: 422, error: "invalid" });
    expect((await POST(request({}))).status).toBe(422);
    mocks.setOwner.mockRejectedValueOnce(new Error("db"));
    expect((await POST(request({}))).status).toBe(503);
    expect(mocks.identity).not.toHaveBeenCalled();
  });
});
