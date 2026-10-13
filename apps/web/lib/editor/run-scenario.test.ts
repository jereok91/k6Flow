import { afterEach, expect, it, vi } from "vitest";
import type { GraphDraftComposition } from "@k6flow/shared";
import { runScenario } from "./run-scenario";

const graph = (): GraphDraftComposition => ({
  version: 1,
  nodes: [
    {
      id: "b",
      kind: "http-request",
      references: [],
      disabled: true,
      parameters: {
        method: "GET",
        url: { kind: "literal", value: "https://example.test/b" },
      },
    },
    {
      id: "a",
      kind: "http-request",
      label: "original",
      position: { x: 1, y: 2 },
      references: [],
      parameters: {
        method: "GET",
        url: { kind: "literal", value: "https://example.test/a" },
      },
    },
  ],
  connections: [{ source: "a", target: "b" }],
});

afterEach(() => vi.unstubAllGlobals());

it("preserves variable loading and CSV admission errors", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await runScenario(graph(), {
    mode: "diagnostic", scenarioId: "s", sessionMarker: MARKER,
  })).toMatchObject({
    success: false,
    error: "Could not load scenario variables (HTTP 500)",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear();
  const csv: GraphDraftComposition = {
    version: 1,
    nodes: [{
      id: "pool",
      kind: "user-pool",
      references: [],
      parameters: {
        version: 1,
        attachment: { id: "users" },
        mode: "csv",
        allocation: "csv-order-distinct-row-per-vu",
        onInsufficientCapacity: "reject-before-execution",
        outputs: [],
      },
    }],
    connections: [],
  };
  const missing = await runScenario(csv, { mode: "diagnostic", sessionMarker: MARKER });
  expect(missing.success).toBe(false);
  expect(missing.missingFiles).toEqual(["users.csv"]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("owns diagnostic inputs before variable loading and uses compiler order", async () => {
  let release!: (r: Response) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(r => {
      release = r;
    }))
    .mockResolvedValueOnce(Response.json({ runId: "run" }));
  vi.stubGlobal("fetch", fetcher);
  const g = graph();
  const config = {
    mode: "diagnostic" as const,
    scenarioId: "s",
    sessionMarker: MARKER,
    vus: 90,
    durationMs: 1000,
    attachments: [{ id: "csv", name: "csv", data: "secret" }],
  };
  const pending = runScenario(g, config);
  g.nodes[1].label = "changed";
  g.nodes[1].position!.x = 90;
  const parameters = g.nodes[1].parameters as { url: { value: string } };
  parameters.url.value = "https://changed.test";
  config.attachments[0].id = "changed";
  release(Response.json({ variables: [] }));
  const result = await pending;
  const body = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(body).toMatchObject({
    mode: "diagnostic",
    vus: 1,
    durationMs: 30000,
    diagnostic: { nodeIds: ["a", "b"] },
    attachments: [{ id: "csv" }],
    requiredEnv: [],
  });
  expect(body.script).toContain("https://example.test/a");
  expect(result.success).toBe(true);
  expect(result.executionDisplay).toEqual([
    {
      id: "a",
      kind: "http-request",
      label: "original",
      position: { x: 1, y: 2 },
      disabled: false,
    },
    {
      id: "b",
      kind: "http-request",
      label: undefined,
      position: undefined,
      disabled: true,
    },
  ]);
  expect(Object.isFrozen(result.executionDisplay![0].position)).toBe(true);
  expect(Object.isFrozen(result.diagnostic!.nodeIds)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("does not serialize load mode and retains load resources", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ runId: "load" }));
  vi.stubGlobal("fetch", fetcher);
  await runScenario(graph(), { mode: "load", vus: 7, durationMs: 9000 });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.mode).toBeUndefined();
  expect(body.diagnostic).toBeUndefined();
  expect(body.vus).toBe(7);
});

const MARKER = "a".repeat(64);

it.each([["missing", undefined], ["malformed", "A".repeat(64)]])(
  "refuses a diagnostic start with a %s session marker before any request", async (_kind, sessionMarker) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await runScenario(graph(), { mode: "diagnostic", sessionMarker })).toEqual({
      success: false, error: "Session not verified", sessionChanged: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

it("sends the session marker only on the diagnostic start request", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ variables: [] }))
    .mockResolvedValueOnce(Response.json({ runId: "run" }));
  vi.stubGlobal("fetch", fetcher);
  const result = await runScenario(graph(), { mode: "diagnostic", scenarioId: "s", sessionMarker: MARKER });
  expect(result.success).toBe(true);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-K6Flow-Session-Marker")).toBeNull();
  const start = new Headers(fetcher.mock.calls[1][1].headers);
  expect(start.get("X-K6Flow-Session-Marker")).toBe(MARKER);
  expect(start.get("Content-Type")).toBe("application/json");
  expect(fetcher.mock.calls[1][1].body).not.toContain(MARKER);
});

it("reports a 412 diagnostic start as a session change with a fixed error", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({ error: "Session changed" }, { status: 412 }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await runScenario(graph(), { mode: "diagnostic", sessionMarker: MARKER })).toEqual({
    success: false, error: "Session changed", sessionChanged: true,
  });
});

it("never sends a marker for load runs", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ runId: "load" }));
  vi.stubGlobal("fetch", fetcher);
  await runScenario(graph(), { mode: "load", sessionMarker: MARKER });
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-K6Flow-Session-Marker")).toBeNull();
});

it("rejects unsupported diagnostic cloning without requests", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const g = graph();
  Object.defineProperty(g, "load", {
    get: () => {
      throw Error("private");
    },
    enumerable: true,
  });
  expect(await runScenario(g, { mode: "diagnostic", sessionMarker: MARKER })).toEqual({
    success: false, error: "Unsupported diagnostic input",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
