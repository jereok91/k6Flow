import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  selectLimit: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.selectLimit() }) }) }),
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: async (conflict: unknown) => {
          mocks.insert({ row, conflict });
        },
      }),
    }),
  }),
}));

import { POST } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const user = { id: "user-1", role: "user" };

const CAPTURE = [
  '{"type":"metadata","data":{"recordingId":"rec-1","startUrl":"https://shop.example.com/login","viewport":{"width":1280,"height":720},"startedAt":1000}}',
  '{"type":"network_entry","data":{"request":{"id":"r1","timestamp":1001,"method":"GET","url":"https://shop.example.com/login","headers":{},"resourceType":"Document"},"response":{"status":200,"headers":{}}}}',
  '{"type":"step","data":{"id":"step-1","name":"Navigate","kind":"auto","timestamp":1002}}',
  '{"type":"end","data":{"endedAt":4000,"reason":"manual"}}',
].join("\n") + "\n";

const request = (body: Record<string, unknown> = { recordingId: "rec-1" }) =>
  new Request("http://localhost/api/recorder/stop", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { cookie: COOKIE, "content-type": "application/json" },
  });

const stopAnswer = (info: Record<string, unknown>) => Response.json(info);
const captureAnswer = (content: string, status = 200) =>
  new Response(content, { status, headers: { "Content-Type": "application/x-ndjson" } });

/** Stubs fetch with the recorder's /stop answer first and its /captures answer second. */
const recorderAnswers = (stop: () => Response, capture: () => Response) => {
  const fetchMock = vi.fn();
  fetchMock.mockImplementationOnce(async () => stop());
  fetchMock.mockImplementationOnce(async () => capture());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("POST /api/recorder/stop", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(user);
    mocks.selectLimit.mockResolvedValue([]);
    mocks.insert.mockReset();
    delete process.env.RECORDER_AUTH_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.RECORDER_AUTH_TOKEN;
  });

  it("refuses an anonymous stop before touching the recorder", async () => {
    mocks.requireUser.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("persists the capture the recorder reports and answers what it saved", async () => {
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request({ recordingId: "rec-1", name: "Flujo de login" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "stopped",
      recordingId: "rec-1",
      persisted: true,
      recording: {
        id: "rec-1",
        name: "Flujo de login",
        startUrl: "https://shop.example.com/login",
        requestCount: 1,
        stepCount: 1,
        durationMs: 3000,
      },
    });

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const { row } = mocks.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      id: "rec-1",
      ownerId: "user-1",
      state: "completed",
      startUrl: "https://shop.example.com/login",
      requestCount: 1,
      stepCount: 1,
      durationMs: 3000,
      captureData: CAPTURE,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("relays a refused stop instead of reporting success", async () => {
    recorderAnswers(
      () => Response.json({ error: "Recording mismatch", recordingId: "rec-other" }, { status: 409 }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request({ recordingId: "rec-1" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Recording mismatch", recordingId: "rec-other" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("reports an unreachable recorder as a gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const response = await POST(request({ recordingId: "rec-1" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Failed to connect to recorder service" });
  });

  it("does not claim persistence when the capture is gone", async () => {
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => Response.json({ error: "Capture not found" }, { status: 404 }),
    );

    const response = await POST(request({ recordingId: "rec-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "stopped",
      recordingId: "rec-1",
      persisted: false,
      recording: null,
      warning: "Capture unavailable",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers with the recording an earlier stop already saved", async () => {
    mocks.selectLimit.mockResolvedValue([
      {
        id: "rec-1",
        ownerId: "user-1",
        name: "Flujo de login",
        startUrl: "https://shop.example.com/login",
        state: "completed",
        durationMs: 3000,
        requestCount: 1,
        stepCount: 1,
        scenarioId: null,
      },
    ]);
    recorderAnswers(
      () => stopAnswer({ status: "idle", recordingId: "rec-1", events: 0, durationMs: 0, reason: "manual" }),
      () => Response.json({ error: "Capture not found" }, { status: 404 }),
    );

    const response = await POST(request({ recordingId: "rec-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "idle",
      recordingId: "rec-1",
      persisted: true,
      recording: { id: "rec-1", name: "Flujo de login", requestCount: 1 },
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("leaves an already saved recording untouched when the user stops again", async () => {
    mocks.selectLimit.mockResolvedValue([
      {
        id: "rec-1",
        ownerId: "user-1",
        name: "Flujo de login",
        startUrl: "https://shop.example.com/login",
        state: "completed",
        durationMs: 3000,
        requestCount: 1,
        stepCount: 1,
        scenarioId: "scenario-1",
      },
    ]);
    const fetchMock = recorderAnswers(
      () => stopAnswer({ status: "idle", recordingId: "rec-1", events: 0, durationMs: 0, reason: "manual" }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request({ recordingId: "rec-1", name: "Otro nombre" }));

    expect(response.status).toBe(200);
    // Repeat stop is idempotent: the stored numbers are the ones the first stop
    // measured, not a recomputation from a different source.
    expect(await response.json()).toMatchObject({
      status: "idle",
      persisted: true,
      recording: {
        id: "rec-1",
        name: "Flujo de login",
        durationMs: 3000,
        scenarioId: "scenario-1",
      },
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite another user's recording", async () => {
    mocks.selectLimit.mockResolvedValue([{ id: "rec-1", ownerId: "someone-else", scenarioId: null }]);
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request({ recordingId: "rec-1" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Recording belongs to another user" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
