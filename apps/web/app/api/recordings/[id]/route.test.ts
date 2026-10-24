import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.selectLimit() }) }) }),
  }),
}));

import { GET } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const CAPTURE = '{"type":"end","data":{"endedAt":10,"reason":"manual"}}\n';

const row = {
  id: "rec-1",
  ownerId: "user-1",
  name: "Flujo de login",
  startUrl: "https://shop.example.com/login",
  state: "completed",
  viewportWidth: 1280,
  viewportHeight: 720,
  durationMs: 3000,
  requestCount: 4,
  stepCount: 2,
  captureData: CAPTURE,
  scenarioId: null,
  createdAt: new Date("2026-10-24T20:00:00Z"),
  completedAt: new Date("2026-10-24T20:00:03Z"),
};

const request = (id: string) =>
  new Request(`http://localhost/api/recordings/${id}`, { headers: { cookie: COOKIE } });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/recordings/[id]", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: "user-1", role: "user" });
    mocks.selectLimit.mockResolvedValue([row]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an anonymous read", async () => {
    mocks.requireUser.mockResolvedValue(null);

    const response = await GET(request("rec-1"), context("rec-1"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns the recording with its capture for the review screen", async () => {
    const response = await GET(request("rec-1"), context("rec-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.capture).toBe(CAPTURE);
    expect(body.recording).toMatchObject({
      id: "rec-1",
      name: "Flujo de login",
      startUrl: "https://shop.example.com/login",
      state: "completed",
      requestCount: 4,
      stepCount: 2,
      durationMs: 3000,
      scenarioId: null,
      viewport: { width: 1280, height: 720 },
    });
    expect(body.recording.createdAt).toBe("2026-10-24T20:00:00.000Z");
  });

  it("answers 404 for a recording that was never saved", async () => {
    mocks.selectLimit.mockResolvedValue([]);

    const response = await GET(request("rec-missing"), context("rec-missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Recording not found" });
  });

  it("hides another user's recording", async () => {
    mocks.selectLimit.mockResolvedValue([{ ...row, ownerId: "someone-else" }]);

    const response = await GET(request("rec-1"), context("rec-1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  it("lets an admin read any recording", async () => {
    mocks.requireUser.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.selectLimit.mockResolvedValue([{ ...row, ownerId: "someone-else" }]);

    const response = await GET(request("rec-1"), context("rec-1"));

    expect(response.status).toBe(200);
  });
});
