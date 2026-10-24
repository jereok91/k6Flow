import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({ getDb: () => ({ insert: mocks.insert }) }));

import { POST } from "./route";

const COOKIE = "k6flow_session=cookie-secret-token";
const user = { id: "user-1" };

interface EntrySpec {
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  startedDateTime: string;
  time?: number;
}

const harEntry = (spec: EntrySpec) => ({
  startedDateTime: spec.startedDateTime,
  time: spec.time ?? 500,
  request: {
    method: spec.method ?? "GET",
    url: spec.url,
    httpVersion: "http/2",
    headers: [],
    queryString: [],
    headersSize: 0,
    bodySize: 0,
  },
  response: {
    status: spec.status ?? 200,
    statusText: "OK",
    httpVersion: "http/2",
    headers: [],
    content: { size: 1, mimeType: spec.mimeType ?? "application/json" },
    redirectURL: "",
    headersSize: 0,
    bodySize: 1,
  },
  cache: {},
  timings: { send: 0, wait: spec.time ?? 500, receive: 0 },
});

const harBody = () => ({
  log: {
    version: "1.2",
    creator: { name: "test", version: "1" },
    entries: [
      harEntry({ url: "https://api.example.com/v1/status", startedDateTime: "2026-01-01T00:00:00.000Z" }),
      harEntry({ url: "https://api.example.com/v1/login", method: "POST", status: 201, startedDateTime: "2026-01-01T00:00:03.000Z", time: 250 }),
      harEntry({ url: "https://cdn.example.com/app.css", mimeType: "text/css", startedDateTime: "2026-01-01T00:00:05.000Z" }),
      harEntry({ url: "https://api.example.com/v1/users", status: 500, startedDateTime: "2026-01-01T00:00:06.000Z" }),
    ],
  },
});

const request = (body: unknown) => new Request("http://localhost/api/import/har", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { cookie: COOKIE, "content-type": "application/json" },
});

const importRequest = (options?: Record<string, unknown>) => request({
  name: "Imported flow",
  har: harBody(),
  ...(options === undefined ? {} : { options }),
});

type ImportedEdge = { from: string; to: string; waitSeconds?: number };
const storedGraph = () => mocks.values.mock.calls[0][0].graph as { edges: ImportedEdge[] };

describe("POST /api/import/har", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue(user);
    mocks.values.mockResolvedValue(undefined);
    mocks.insert.mockReturnValue({ values: mocks.values });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated import before touching the database", async () => {
    mocks.requireUser.mockResolvedValue(null);

    const response = await POST(importRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("imports with the legacy defaults when the body carries no options", async () => {
    const response = await POST(request({ name: "Imported flow", har: harBody() }));

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; name: string; stats: Record<string, number> };
    expect(body.name).toBe("Imported flow");
    expect(body.id).toEqual(expect.any(String));
    // excludeStatic defaults to true, so the stylesheet is skipped.
    expect(body.stats).toEqual({ totalEntries: 4, importedEntries: 3, skippedEntries: 1, steps: 3 });

    // useHarTimings defaults to true, so connections carry waits from the HAR.
    const waits = storedGraph().edges.map((edge) => edge.waitSeconds);
    expect(waits).toEqual([2.5, 2.75]);
  });

  it("transports the new filters to the importer", async () => {
    const response = await POST(importRequest({
      includeResourceTypes: ["xhr"],
      excludeDomains: ["cdn.example.com"],
      statusMax: 299,
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { stats: Record<string, number> };
    expect(body.stats).toEqual({ totalEntries: 4, importedEntries: 2, skippedEntries: 2, steps: 2 });

    const waits = storedGraph().edges.map((edge) => edge.waitSeconds);
    expect(waits).toEqual([2.5]);
  });

  it("honours useHarTimings = false", async () => {
    const response = await POST(importRequest({ useHarTimings: false }));

    expect(response.status).toBe(201);
    expect(storedGraph().edges.map((edge) => edge.waitSeconds)).toEqual([undefined, undefined]);
  });

  it("rejects an unknown resource type instead of importing unfiltered", async () => {
    const response = await POST(importRequest({ includeResourceTypes: ["beacon"] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unknown resource type in includeResourceTypes: beacon" });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("rejects an unknown excluded resource type too", async () => {
    const response = await POST(importRequest({ excludeResourceTypes: ["Native"] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unknown resource type in excludeResourceTypes: Native" });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("rejects a status range whose minimum exceeds its maximum", async () => {
    const response = await POST(importRequest({ statusMin: 500, statusMax: 200 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "statusMin must not be greater than statusMax" });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("rejects malformed filter payloads", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ includeResourceTypes: "xhr" }, "includeResourceTypes must be an array of strings"],
      [{ methods: [200] }, "methods must be an array of strings"],
      [{ statusMin: "200" }, "statusMin must be a finite number"],
      [{ stepGapMs: "fast" }, "stepGapMs must be a finite number"],
      [{ useHarTimings: "yes" }, "useHarTimings must be a boolean"],
      [{ urlFilter: "([a-z" }, "Invalid URL filter regex"],
    ];

    for (const [options, error] of cases) {
      const response = await POST(importRequest(options));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(mocks.values).not.toHaveBeenCalled();
  });
});
