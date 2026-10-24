import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  selectResults: [] as unknown[][],
  inserts: [] as Array<{ table: unknown; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock("../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
const database = {
  // Where() answers both shapes the route uses: awaited directly, and .limit(1).
  select: () => ({
    from: () => ({
      where: () => {
        const rows = (mocks.selectResults.shift() ?? []) as unknown[];
        const pending = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
        pending.limit = async () => rows;
        return pending;
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: async (row: Record<string, unknown>) => {
      mocks.inserts.push({ table, row });
    },
  }),
  update: (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        mocks.updates.push({ table, values });
      },
    }),
  }),
  // A save is atomic: the route runs it inside one transaction.
  transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
};

vi.mock("../../../lib/db/client", () => ({ getDb: () => database }));

import { POST } from "./route";
import { recordings, scenarios, scenarioVersions } from "../../../lib/db/schema";

const COOKIE = "k6flow_session=cookie-secret-token";
const user = { id: "user-1", role: "user" };

const entry = (id: string, url: string) => ({
  entry: {
    request: { id, timestamp: 1, method: "GET", url, headers: {}, resourceType: "Document" },
    response: { id, timestamp: 2, status: 200, statusText: "OK", headers: {}, mimeType: "text/html", bodySize: 1, bodyTruncated: false },
    timing: { startTime: 1, endTime: 2, durationMs: 1 },
  },
  stepId: "step-1",
  stepName: "Navigate",
  thinkTime: 0,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  name: "Flujo de login",
  startUrl: "https://shop.example.com/login",
  recordingId: "rec-1",
  entries: [entry("r1", "https://shop.example.com/login")],
  ...overrides,
});

const request = (payload: Record<string, unknown>) =>
  new Request("http://localhost/api/recordings", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { cookie: COOKIE, "content-type": "application/json" },
  });

const insertInto = (table: unknown) => mocks.inserts.filter((call) => call.table === table);

describe("POST /api/recordings", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(user);
    mocks.selectResults = [];
    mocks.inserts = [];
    mocks.updates = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an anonymous save", async () => {
    mocks.requireUser.mockResolvedValue(null);

    const response = await POST(request(body()));

    expect(response.status).toBe(401);
    expect(mocks.inserts).toHaveLength(0);
  });

  it("rejects a save with no entries to derive", async () => {
    const response = await POST(request(body({ entries: [] })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No entries to save" });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("records the first version of a scenario created from a recording", async () => {
    const response = await POST(request(body()));

    expect(response.status).toBe(200);
    const saved = await response.json();

    const [scenario] = insertInto(scenarios);
    expect(scenario.row).toMatchObject({ id: saved.id, ownerId: user.id, name: "Flujo de login" });

    // The graph the user just saved is version 1 of the new scenario, with the
    // recording it came from kept as provenance.
    const [version] = insertInto(scenarioVersions);
    expect(version.row).toMatchObject({
      scenarioId: saved.id,
      version: 1,
      graph: scenario.row.graph,
      changeDescription: "Created from recording: Flujo de login",
      sourceRecordingId: "rec-1",
      createdBy: user.id,
    });

    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]).toMatchObject({
      table: recordings,
      values: { scenarioId: saved.id, state: "completed" },
    });
  });

  it("still creates the version when the scenario is not linked to a recording", async () => {
    const { recordingId: _omitted, ...withoutRecording } = body();

    const response = await POST(request(withoutRecording));

    expect(response.status).toBe(200);
    const [version] = insertInto(scenarioVersions);
    expect(version.row).toMatchObject({ version: 1, sourceRecordingId: null });
    expect(mocks.updates).toHaveLength(0);
  });

  it("keeps appending a recording as the next version of an existing scenario", async () => {
    // 1: the existing scenario, 2: its highest version so far.
    mocks.selectResults = [
      [{ id: "scenario-1", ownerId: user.id, name: "Existente", graph: { version: 1, nodes: {} } }],
      [{ version: 3 }],
    ];

    const response = await POST(request(body({ appendToScenarioId: "scenario-1" })));

    expect(response.status).toBe(200);
    const [version] = insertInto(scenarioVersions);
    expect(version.row).toMatchObject({
      scenarioId: "scenario-1",
      version: 4,
      graph: { version: 1, nodes: {} },
      changeDescription: "Before appending recording: Flujo de login",
    });
    expect(insertInto(scenarios)).toHaveLength(0);
  });
});
