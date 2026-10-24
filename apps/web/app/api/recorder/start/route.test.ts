import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  selectResults: [] as unknown[][],
  inserts: [] as Array<{ row: Record<string, unknown>; conflict: Record<string, unknown> | null }>,
  getDb: vi.fn(),
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({ getDb: mocks.getDb }));

import { POST } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const user = { id: "user-1", role: "user" };
const START_URL = "https://shop.example.com/login";

const database = {
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
};

const request = (body: Record<string, unknown> = { startUrl: START_URL }) =>
  new Request("http://localhost/api/recorder/start", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { cookie: COOKIE, "content-type": "application/json" },
  });

const recorderStarted = (recordingId = "rec-1") =>
  async () => Response.json({ recordingId, wsUrl: `/ws/recordings/${recordingId}?token=dev-token` });

describe("POST /api/recorder/start", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(user);
    mocks.selectResults = [[]];
    mocks.inserts = [];
    mocks.getDb.mockReturnValue(database);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("refuses an anonymous start before touching the recorder", async () => {
    mocks.requireUser.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.inserts).toHaveLength(0);
  });

  it("reserves the recording for the caller so only they can stop it", async () => {
    // 1: no row yet, 2: the confirmation read after the upsert.
    mocks.selectResults = [[], [{ ownerId: user.id, state: "recording" }]];
    const fetchMock = vi.fn().mockImplementation(recorderStarted());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ startUrl: START_URL, name: "Flujo de login" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recordingId: "rec-1", name: "Flujo de login" });

    expect(mocks.inserts).toHaveLength(1);
    const { row, conflict } = mocks.inserts[0];
    expect(row).toMatchObject({
      id: "rec-1",
      ownerId: "user-1",
      name: "Flujo de login",
      startUrl: START_URL,
      state: "recording",
      viewportWidth: 1280,
      viewportHeight: 720,
    });
    // Reconnecting must not resurrect a finished recording's terminal state.
    expect(conflict).toHaveProperty("setWhere");

    // The recorder mints the id: a caller-supplied one must never be forwarded, or
    // it could name another user's recording.
    const forwarded = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(forwarded).not.toHaveProperty("recordingId");
    expect(forwarded).toMatchObject({ startUrl: START_URL });
  });

  it("refuses to reopen a finished recording and abandons the session it started", async () => {
    mocks.selectResults = [[{ ownerId: user.id, state: "completed" }]];
    const fetchMock = vi.fn().mockImplementation(recorderStarted());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Recording already finished" });
    expect(mocks.inserts).toHaveLength(0);
    // A finished id can never be live again: the session it did create is stopped.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names an unnamed recording from its start host", async () => {
    mocks.selectResults = [[], [{ ownerId: user.id, state: "recording" }]];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(recorderStarted()));

    const response = await POST(request({ startUrl: START_URL }));
    const body = await response.json();

    expect(body.name).toContain("shop.example.com");
    expect(mocks.inserts[0].row).toMatchObject({ name: body.name });
  });

  it("relays a recorder start the service refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Recording id already used" }, { status: 409 })));

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Recording id already used" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("refuses to adopt a live recording owned by another user without stopping it", async () => {
    mocks.selectResults = [[{ ownerId: "someone-else" }]];
    // The recorder hands back the live session it already has: this is the reconnect
    // path, and a refusal must leave that browser running for its owner.
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "reconnected", recordingId: "rec-live" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    // A reconnect is only adoptable by the owner of its row, decided before any write.
    expect(await response.json()).toEqual({ error: "Recorder is busy with another recording" });
    expect(mocks.inserts).toHaveLength(0);
    // That browser is still recording for its owner: a refusal must not touch it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a recorder answer without a recording id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ wsUrl: "/ws/recordings/x" })));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Recorder did not return a recording id" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("never abandons a session the recorder handed back as a reconnect", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "reconnected", recordingId: "rec-live" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(503);
    // A reconnected session belongs to whoever started it: only a session this
    // request created may be abandoned.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the session it just started when the reservation cannot be stored", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const fetchMock = vi.fn().mockImplementation(recorderStarted());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Recording store unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
