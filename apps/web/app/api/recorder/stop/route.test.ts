import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  // One entry per select the route performs, in order.
  selectResults: [] as unknown[][],
  inserts: [] as Array<{ row: Record<string, unknown>; conflict: Record<string, unknown> }>,
  updates: [] as Array<{ values: Record<string, unknown> }>,
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mocks.selectResults.shift() ?? [],
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
          mocks.inserts.push({ row, conflict });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.updates.push({ values });
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

const reservedRow = {
  id: "rec-1",
  ownerId: "user-1",
  name: "Flujo de login",
  startUrl: "https://shop.example.com/login",
  state: "recording",
  durationMs: null,
  requestCount: null,
  stepCount: null,
  scenarioId: null,
};

const completedRow = {
  ...reservedRow,
  state: "completed",
  durationMs: 3000,
  requestCount: 1,
  stepCount: 1,
};

const request = (body: Record<string, unknown> = { recordingId: "rec-1" }) =>
  new Request("http://localhost/api/recorder/stop", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { cookie: COOKIE, "content-type": "application/json" },
  });

const stopAnswer = (info: Record<string, unknown>, status = 200) =>
  Response.json(info, { status });
const captureAnswer = (content: string, status = 200) =>
  new Response(content, { status, headers: { "Content-Type": "application/x-ndjson" } });

/** Stubs the recorder calls in order: /stop, /captures download, /captures delete. */
const recorderAnswers = (stop: () => Response, capture: () => Response) => {
  const fetchMock = vi.fn();
  fetchMock.mockImplementationOnce(async () => stop());
  fetchMock.mockImplementationOnce(async () => capture());
  fetchMock.mockImplementationOnce(async () => Response.json({ status: "deleted" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("POST /api/recorder/stop", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(user);
    mocks.selectResults = [[reservedRow], [completedRow]];
    mocks.inserts = [];
    mocks.updates = [];
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
    expect(mocks.inserts).toHaveLength(0);
  });

  it("refuses a stop without a recording id, which could only stop whatever is live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing recording id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a recording this user does not own, before stopping anything", async () => {
    mocks.selectResults = [[{ ...reservedRow, ownerId: "someone-else" }]];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    // Indistinguishable from a missing id: recorder ids are timestamp-derived.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Recording not found" });
    // The destructive call never reaches the shared recorder session.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.inserts).toHaveLength(0);
  });

  it("answers 404 for a recording that was never reserved", async () => {
    mocks.selectResults = [[]];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Recording not found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists the capture of a recording the caller started", async () => {
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request({ recordingId: "rec-1", name: "Flujo de login" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
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
        captureBytes: Buffer.byteLength(CAPTURE, "utf8"),
      },
    });

    expect(mocks.inserts).toHaveLength(1);
    const { row, conflict } = mocks.inserts[0];
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
    // The terminal row is written once, never re-written by a concurrent retry.
    expect(conflict).toHaveProperty("setWhere");
  });

  it("relays a refused stop instead of reporting success", async () => {
    recorderAnswers(
      () => Response.json({ error: "Failed to stop recording" }, { status: 500 }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to stop recording" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("reports an unreachable recorder as a gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Failed to connect to recorder service" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("collects the capture of a recording that ended on its own", async () => {
    // The recorder answers 409 when another session is live: this recording is
    // already over, so its capture is final and the live session stays untouched.
    recorderAnswers(
      () => Response.json({ error: "Recording mismatch", recordingId: "rec-other" }, { status: 409 }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      // Not "stopped": the recorder stopped nothing, the capture proves it ended.
      status: "ended",
      recordingId: "rec-1",
      persisted: true,
    });
    expect(mocks.inserts).toHaveLength(1);
  });

  it("relays the recorder rejection when a refused stop has no final capture", async () => {
    // 1: the reserved row, 2: the re-read that finds nothing a retry saved.
    mocks.selectResults = [[reservedRow], []];
    recorderAnswers(
      () => Response.json({ error: "Recording mismatch", recordingId: "rec-other" }, { status: 409 }),
      () => Response.json({ error: "Capture not found" }, { status: 404 }),
    );

    const response = await POST(request());

    // No capture means nothing proves the recording is over: the caller must see the
    // rejection and retry instead of believing the stop succeeded. The recorder's own
    // body is never relayed, because it names whichever session is live.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Failed to stop recording" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("does not store a capture that never got its end marker", async () => {
    // A crash or a failed flush leaves a readable file: storing it would hand the
    // review screen a truncated recording and report success for it.
    const partial = CAPTURE.split("\n").filter((line) => !line.includes('"type":"end"')).join("\n") + "\n";
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => captureAnswer(partial),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "stopped",
      recordingId: "rec-1",
      persisted: false,
      recording: null,
      warning: "Capture incomplete",
    });
    expect(mocks.inserts).toHaveLength(0);
    // A partial capture can never become usable: the row stops claiming to record.
    expect(mocks.updates[0]).toMatchObject({ values: { state: "failed" } });
  });

  it("refuses a capture larger than the tier will store", async () => {
    // One endless recording must not force the web process to hold it in memory.
    mocks.selectResults = [[reservedRow], []];
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => new Response("", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      persisted: false,
      recording: null,
      warning: "Capture too large",
    });
    expect(mocks.inserts).toHaveLength(0);
    // One oversized recording must not be retried forever against the recorder.
    expect(mocks.updates[0]).toMatchObject({ values: { state: "failed" } });
  });

  it("does not claim persistence when the capture is gone", async () => {
    // 1: the reserved row, 2: the re-read that looks for a row a retry already saved.
    mocks.selectResults = [[reservedRow], []];
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 3000, reason: "manual" }),
      () => Response.json({ error: "Capture not found" }, { status: 404 }),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "stopped",
      recordingId: "rec-1",
      persisted: false,
      recording: null,
      warning: "Capture unavailable",
    });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("answers a recording already saved without stopping anything", async () => {
    mocks.selectResults = [[completedRow]];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({ status: "deleted", method: init?.method ?? "GET" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ recordingId: "rec-1", name: "Otro nombre" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "idle",
      persisted: true,
      recording: { id: "rec-1", name: "Flujo de login", durationMs: 3000 },
    });
    // No stop call: the recording is over. The retry only releases a capture whose
    // earlier delete failed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("answers the row the first stop wrote when a retry loses the race", async () => {
    const winner = { ...completedRow, durationMs: 3000, requestCount: 7 };
    // 1: the reserved row this request read, 2: what the concurrent stop stored.
    mocks.selectResults = [[reservedRow], [winner]];
    recorderAnswers(
      () => stopAnswer({ status: "stopped", recordingId: "rec-1", events: 4, durationMs: 7540, reason: "manual" }),
      () => captureAnswer(CAPTURE),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    const body = await response.json();
    // The stored row wins over this request's own recomputation.
    expect(body.recording).toMatchObject({ durationMs: 3000, requestCount: 7 });
  });
});
