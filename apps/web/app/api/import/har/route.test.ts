import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
}));

vi.mock("../../../../lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../../../lib/db/client", () => ({ getDb: () => ({ insert: mocks.insert }) }));

import { graphDraftCompositionSchema } from "@k6flow/shared";
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
  headers?: Record<string, string>;
}

const harEntry = (spec: EntrySpec) => ({
  startedDateTime: spec.startedDateTime,
  time: spec.time ?? 500,
  request: {
    method: spec.method ?? "GET",
    url: spec.url,
    httpVersion: "http/2",
    headers: Object.entries(spec.headers ?? {}).map(([name, value]) => ({ name, value })),
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

// Two requests of the same origin that share a credential and query a token.
const credentialedHarBody = () => ({
  log: {
    version: "1.2",
    creator: { name: "test", version: "1" },
    entries: [
      harEntry({
        url: "https://api.example.com/v1/status",
        startedDateTime: "2026-01-01T00:00:00.000Z",
        headers: { authorization: "Bearer abc123", cookie: "session=abc123" },
      }),
      harEntry({
        url: "https://api.example.com/v1/users?token=supersecret1",
        startedDateTime: "2026-01-01T00:00:03.000Z",
        headers: { authorization: "Bearer abc123" },
      }),
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

type StoredParameterValue = { kind: string; value?: string };
type StoredParameters = {
  url?: StoredParameterValue;
  headers?: Array<{ name: string; value: StoredParameterValue }>;
};
type StoredConnection = { source: string; target: string; waitSeconds?: number };
type StoredComposition = {
  version: number;
  nodes: Array<{ id: string; kind: string; label?: string; parameters?: StoredParameters }>;
  connections: StoredConnection[];
};
const storedGraph = () => mocks.values.mock.calls[0][0].graph as StoredComposition;
const storedWaits = () => storedGraph().connections.map((connection) => connection.waitSeconds);
const storedUrls = () => storedGraph().nodes.map((node) => node.parameters?.url?.value);
const storedHeaders = (index: number) =>
  storedGraph().nodes[index].parameters?.headers?.map((header) => [header.name, header.value.value]);

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
    expect(storedWaits()).toEqual([2.5, 2.75]);
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

    expect(storedWaits()).toEqual([2.5]);
  });

  it("honours useHarTimings = false", async () => {
    const response = await POST(importRequest({ useHarTimings: false }));

    expect(response.status).toBe(201);
    expect(storedWaits()).toEqual([undefined, undefined]);
  });

  it("stores the graph composition the editor can open, not the raw imported graph", async () => {
    const response = await POST(importRequest());

    expect(response.status).toBe(201);
    const stored = storedGraph();
    // The raw HarImportedGraph shape (nodes record, edges, startNode) is gone.
    expect(stored).not.toHaveProperty("edges");
    expect(stored).not.toHaveProperty("startNode");
    expect(Array.isArray(stored.nodes)).toBe(true);
    expect(stored.version).toBe(1);
    expect(stored.nodes.map((node) => node.kind)).toEqual(["http-request", "http-request", "http-request"]);
    expect(stored.connections).toEqual([
      { source: stored.nodes[0].id, target: stored.nodes[1].id, waitSeconds: 2.5 },
      { source: stored.nodes[1].id, target: stored.nodes[2].id, waitSeconds: 2.75 },
    ]);
    expect(graphDraftCompositionSchema.safeParse(stored).success).toBe(true);
  });

  it("appends the bridge warnings to the response without changing its shape", async () => {
    const upload = harEntry({
      url: "https://api.example.com/v1/upload",
      method: "POST",
      startedDateTime: "2026-01-01T00:00:00.000Z",
    });
    const response = await POST(request({
      name: "Imported flow",
      har: {
        log: {
          version: "1.2",
          creator: { name: "test", version: "1" },
          entries: [{
            ...upload,
            request: {
              ...upload.request,
              postData: { mimeType: "multipart/form-data; boundary=--x", text: "------x" },
            },
          }],
        },
      },
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { warnings: string[]; stats: Record<string, number> };
    expect(body.stats.importedEntries).toBe(1);
    expect(body.warnings).toEqual([
      'Content type "multipart/form-data" on "Step 1: POST /v1/upload" cannot be represented by the typed body; the body was imported as text',
    ]);
    expect(graphDraftCompositionSchema.safeParse(storedGraph()).success).toBe(true);
  });

  it("returns the variable suggestions without applying them by default", async () => {
    const response = await POST(importRequest());

    expect(response.status).toBe(201);
    const body = await response.json() as { variableSuggestions: Array<Record<string, unknown>> };
    expect(body.variableSuggestions).toEqual([{
      name: "baseUrl",
      value: "https://api.example.com",
      secret: false,
      kind: "host",
      occurrences: 3,
      reasonCode: "single-origin",
      detail: "All 3 imported requests use the origin https://api.example.com",
    }]);
    // Suggestions are advice: the stored graph keeps the concrete origin.
    expect(storedUrls()).toEqual([
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/login",
      "https://api.example.com/v1/users",
    ]);
  });

  it("applies the suggestions when the request sets applySuggestedVariables", async () => {
    const response = await POST(request({
      name: "Imported flow",
      har: credentialedHarBody(),
      applySuggestedVariables: true,
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { variableSuggestions: Array<{ name: string }> };
    expect(body.variableSuggestions.map((suggestion) => suggestion.name))
      .toEqual(["baseUrl", "authToken", "cookie_session", "token"]);
    expect(storedUrls()).toEqual([
      "{{baseUrl}}/v1/status",
      "{{baseUrl}}/v1/users?token={{token}}",
    ]);
    // The shared credential is gone from the stored graph, and the cookie value
    // (a substring of the authorization value) survived the longest-first pass.
    expect(storedHeaders(0)).toEqual([
      ["authorization", "{{authToken}}"],
      ["cookie", "session={{cookie_session}}"],
    ]);
    expect(graphDraftCompositionSchema.safeParse(storedGraph()).success).toBe(true);
  });

  it("stores the concrete values when applySuggestedVariables is false", async () => {
    const response = await POST(request({
      name: "Imported flow",
      har: credentialedHarBody(),
      applySuggestedVariables: false,
    }));

    expect(response.status).toBe(201);
    expect(storedUrls()).toEqual([
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/users?token=supersecret1",
    ]);
    expect(storedHeaders(0)).toEqual([
      ["authorization", "Bearer abc123"],
      ["cookie", "session=abc123"],
    ]);
  });

  it("rejects an applySuggestedVariables flag that is not a boolean", async () => {
    const response = await POST(request({
      name: "Imported flow",
      har: harBody(),
      applySuggestedVariables: "yes",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "applySuggestedVariables must be a boolean" });
    expect(mocks.values).not.toHaveBeenCalled();
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
