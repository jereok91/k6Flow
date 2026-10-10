import { afterEach, expect, it, vi } from "vitest";
import { classifyDiagnosticRun } from "./diagnostic-classification";

afterEach(() => vi.useRealTimers());

it("only 409 confirms load; every other failure remains unavailable", async () => {
  for (const status of [401, 403, 404, 409, 500, 502]) {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    expect((await classifyDiagnosticRun("r", { fetch: fetcher })).kind).toBe(
      status === 409 ? "load" : "unavailable",
    );
  }
  expect(
    (await classifyDiagnosticRun("r", {
      fetch: vi.fn().mockRejectedValue(Error("private")),
    })).kind,
  ).toBe("unavailable");
  expect(
    (await classifyDiagnosticRun("r", {
      fetch: vi.fn().mockResolvedValue(Response.json({ invalid: true })),
    })).kind,
  ).toBe("unavailable");
});

it("guards a late ignored-abort probe and bounds unresolved requests", async () => {
  vi.useFakeTimers();
  let release!: (r: Response) => void;
  let generation = 1;
  const controller = new AbortController();
  const pending = classifyDiagnosticRun("r", {
    fetch: vi.fn(() => new Promise<Response>(r => {
      release = r;
    })),
    signal: controller.signal,
    isCurrent: () => generation === 1,
  });
  generation = 2;
  controller.abort();
  release(new Response(null, { status: 409 }));
  expect((await pending).kind).toBe("stale");
  const timeout = classifyDiagnosticRun("r", {
    fetch: vi.fn(() => new Promise<Response>(() => {})),
    timeoutMs: 10,
  });
  const asserted = expect(timeout).resolves.toEqual({
    kind: "unavailable",
    error: "diagnostic-unavailable",
  });
  await vi.advanceTimersByTimeAsync(10);
  await asserted;
});

it("validates recovery and guards stale callers", async () => {
  const response = () => Response.json({
    version: 1,
    runId: "r",
    status: "running",
    diagnostic: { nodeIds: ["n"] },
    trace: { state: "running", events: [] },
  });
  expect(
    (await classifyDiagnosticRun("r", {
      fetch: vi.fn().mockResolvedValue(response()),
    })).kind,
  ).toBe("diagnostic");
  expect(
    (await classifyDiagnosticRun("r", {
      fetch: vi.fn().mockResolvedValue(response()),
      isCurrent: () => false,
    })).kind,
  ).toBe("stale");
});
