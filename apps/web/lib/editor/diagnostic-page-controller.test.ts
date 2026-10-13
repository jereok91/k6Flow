import { expect, it, vi } from "vitest";
import { DiagnosticPageController, statusPatchBody } from "./diagnostic-page-controller";
import type { DiagnosticClassification } from "./diagnostic-classification";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot";

const snapshot = parseDiagnosticSnapshot({
  version: 1, runId: "h", status: "running", diagnostic: { nodeIds: ["n"] }, trace: { state: "running", events: [] },
}, "h");
const display = Object.freeze([]);

function deferred() {
  let resolve!: (c: DiagnosticClassification) => void;
  const promise = new Promise<DiagnosticClassification>(r => { resolve = r; });
  return { promise, resolve };
}

it("shares one synchronous latch between load and diagnostic launches", () => {
  const c = new DiagnosticPageController({ classify: vi.fn(), watch: vi.fn(), reconcile: vi.fn() });
  const load = c.acquire("load");
  expect(load).not.toBeNull();
  expect(c.acquire("load")).toBeNull();
  expect(c.acquire("diagnostic")).toBeNull();
  expect(c.state.busy).toBe("load");
  c.release(load!);
  expect(c.state.busy).toBeNull();
  const diag = c.acquire("diagnostic");
  expect(c.acquire("load")).toBeNull();
  c.release(load!); // stale token cannot free another holder
  expect(c.state.busy).toBe("diagnostic");
  c.release(diag!);
  expect(c.state.busy).toBeNull();
});

it("opens a launched diagnostic with a fresh key and holds the latch until terminal", () => {
  const c = new DiagnosticPageController({ classify: vi.fn(), watch: vi.fn(), reconcile: vi.fn() });
  const token = c.acquire("diagnostic")!;
  expect(c.openLaunched(token, "r1", display)).toBe(true);
  const first = c.state.selection;
  expect(first).toMatchObject({ kind: "diagnostic", runId: "r1", executionDisplay: display });
  expect(c.state.busy).toBe("diagnostic");
  expect(c.terminal("other", "completed")).toBe(false);
  expect(c.state.busy).toBe("diagnostic");
  expect(c.terminal("r1", "completed")).toBe(true);
  expect(c.state.busy).toBeNull();
  expect(c.state.selection).toBe(first);
  const next = c.acquire("diagnostic")!;
  c.openLaunched(next, "r2", display);
  expect(c.state.selection.kind === "diagnostic" && c.state.selection.key).not.toBe(
    first.kind === "diagnostic" && first.key);
});

function watching() {
  const watches: { runId: string; done(status: "completed" | "failed" | "stopped" | null): void; dispose: ReturnType<typeof vi.fn> }[] = [];
  const watch = vi.fn((runId: string, done: (status: "completed" | "failed" | "stopped" | null) => void) => {
    const dispose = vi.fn();
    watches.push({ runId, done, dispose });
    return dispose;
  });
  return { watches, watch };
}

it("keeps the latch after closing or navigating away until a background watcher sees terminal", async () => {
  const { watches, watch } = watching();
  const reconcile = vi.fn();
  const c = new DiagnosticPageController({
    classify: vi.fn(async () => ({ kind: "load" as const })), watch, reconcile,
  });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  expect(c.state).toMatchObject({ busy: "diagnostic", selection: { kind: "closed" } });
  expect(c.acquire("load")).toBeNull();
  expect(watch).toHaveBeenCalledTimes(1);
  expect(watches[0].runId).toBe("r1");
  await c.view("h");
  expect(watch).toHaveBeenCalledTimes(1);
  expect(c.state.busy).toBe("diagnostic");
  watches[0].done("stopped");
  expect(c.state.busy).toBeNull();
  expect(reconcile).toHaveBeenCalledWith("r1", "stopped");
  watches[0].done("completed");
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it("an unobservable watcher result releases the latch without a PATCH", () => {
  const { watches, watch } = watching();
  const reconcile = vi.fn();
  const c = new DiagnosticPageController({ classify: vi.fn(), watch, reconcile });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  watches[0].done(null);
  expect(c.state.busy).toBeNull();
  expect(reconcile).not.toHaveBeenCalled();
});

it("a watcher that throws on start releases instead of sticking the latch", () => {
  const c = new DiagnosticPageController({
    classify: vi.fn(), watch: () => { throw Error("private"); }, reconcile: vi.fn(),
  });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  expect(c.state.busy).toBeNull();
});

it("a reopened panel's terminal frees the held run and disposes its watcher", async () => {
  const { watches, watch } = watching();
  const reconcile = vi.fn();
  const c = new DiagnosticPageController({
    classify: vi.fn(async () => ({ kind: "diagnostic" as const, snapshot })), watch, reconcile,
  });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  await c.view("r1");
  expect(c.state.busy).toBe("diagnostic");
  expect(c.terminal("r1", "completed")).toBe(true);
  expect(watches[0].dispose).toHaveBeenCalledTimes(1);
  expect(c.state.busy).toBeNull();
  expect(reconcile).toHaveBeenCalledWith("r1", "completed");
  watches[0].done("failed");
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it("refuses a second open for the same launch hold", () => {
  const c = new DiagnosticPageController({ classify: vi.fn(), watch: vi.fn(), reconcile: vi.fn() });
  const token = c.acquire("diagnostic")!;
  expect(c.openLaunched(token, "a", display)).toBe(true);
  expect(c.openLaunched(token, "b", display)).toBe(false);
  expect(c.state.selection).toMatchObject({ runId: "a" });
  expect(c.terminal("b", "completed")).toBe(false);
  expect(c.terminal("a", "completed")).toBe(true);
});

it("reconciles history-viewed terminals once per run without touching a load hold", async () => {
  const reconcile = vi.fn();
  const c = new DiagnosticPageController({
    classify: vi.fn(async () => ({ kind: "diagnostic" as const, snapshot })), watch: vi.fn(), reconcile,
  });
  const load = c.acquire("load")!;
  await c.view("h");
  expect(c.terminal("h", "failed")).toBe(false);
  expect(c.terminal("h", "failed")).toBe(false);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(c.state.busy).toBe("load");
  c.release(load);
});

it("a re-entrant reconcile cannot free a newer load hold", () => {
  const { watches, watch } = watching();
  let c!: DiagnosticPageController;
  let load: ReturnType<DiagnosticPageController["acquire"]> = null;
  const reconcile = vi.fn(() => {
    c.clearForSession();
    load = c.acquire("load");
  });
  c = new DiagnosticPageController({ classify: vi.fn(), watch, reconcile });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  watches[0].done("completed");
  expect(load).not.toBeNull();
  expect(c.state.busy).toBe("load");
  const d = new DiagnosticPageController({ classify: vi.fn(), watch: vi.fn(), reconcile: vi.fn(() => {
    d.clearForSession();
    load = d.acquire("load");
  }) });
  d.openLaunched(d.acquire("diagnostic")!, "r2", display);
  expect(d.terminal("r2", "completed")).toBe(false);
  expect(d.state.busy).toBe("load");
});

it("a watch without a disposer is not started twice", async () => {
  const watch = vi.fn(() => undefined as unknown as () => void);
  const c = new DiagnosticPageController({ classify: vi.fn(async () => ({ kind: "load" as const })), watch, reconcile: vi.fn() });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  await c.view("h");
  expect(watch).toHaveBeenCalledTimes(1);
  expect(c.state.busy).toBe("diagnostic");
});

it("dispose stops a background watcher", () => {
  const { watches, watch } = watching();
  const c = new DiagnosticPageController({ classify: vi.fn(), watch, reconcile: vi.fn() });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  c.dispose();
  expect(watches[0].dispose).toHaveBeenCalledTimes(1);
});

it("classifies history first: only load, diagnostic or unavailable, never load fallback", async () => {
  const results: DiagnosticClassification[] = [
    { kind: "diagnostic", snapshot }, { kind: "load" }, { kind: "unavailable", error: "diagnostic-unavailable" },
  ];
  const classify = vi.fn(async () => results.shift()!);
  const c = new DiagnosticPageController({ classify, watch: vi.fn(), reconcile: vi.fn() });
  await c.view("h");
  expect(c.state.selection).toMatchObject({ kind: "diagnostic", runId: "h", initialSnapshot: snapshot });
  expect(c.state.selection).not.toHaveProperty("executionDisplay");
  await c.view("h");
  expect(c.state.selection).toEqual({ kind: "load", runId: "h" });
  await c.view("h");
  expect(c.state.selection).toEqual({ kind: "unavailable", runId: "h" });
  expect(classify).toHaveBeenCalledTimes(3);
});

it("retries only an unavailable selection", async () => {
  const classify = vi.fn()
    .mockResolvedValueOnce({ kind: "unavailable", error: "diagnostic-unavailable" })
    .mockResolvedValueOnce({ kind: "load" });
  const c = new DiagnosticPageController({ classify, watch: vi.fn(), reconcile: vi.fn() });
  await c.retry();
  expect(classify).not.toHaveBeenCalled();
  await c.view("h");
  await c.retry();
  expect(c.state.selection).toEqual({ kind: "load", runId: "h" });
  await c.retry();
  expect(classify).toHaveBeenCalledTimes(2);
});

it("ignores stale classifications after a newer view, close or session clear", async () => {
  const pending = [deferred(), deferred(), deferred()];
  const classify = vi.fn((_runId: string, opts: { isCurrent(): boolean }) => {
    const d = pending[classify.mock.calls.length - 1];
    return d.promise.then(r => (opts.isCurrent() ? r : { kind: "stale" as const }));
  });
  const c = new DiagnosticPageController({ classify, watch: vi.fn(), reconcile: vi.fn() });
  const a = c.view("a");
  const b = c.view("b");
  pending[0].resolve({ kind: "load" });
  await a;
  expect(c.state.selection).toEqual({ kind: "classifying", runId: "b" });
  c.clearForSession();
  pending[1].resolve({ kind: "diagnostic", snapshot });
  await b;
  expect(c.state.selection).toEqual({ kind: "closed" });
  const third = c.view("c");
  c.close();
  pending[2].resolve({ kind: "load" });
  await third;
  expect(c.state.selection).toEqual({ kind: "closed" });
});

it("drops a stale raw result even if the classifier ignores isCurrent", async () => {
  const d = deferred();
  const c = new DiagnosticPageController({ classify: () => d.promise, watch: vi.fn(), reconcile: vi.fn() });
  const pending = c.view("a");
  c.close();
  d.resolve({ kind: "diagnostic", snapshot });
  await pending;
  expect(c.state.selection).toEqual({ kind: "closed" });
});

it("session clear erases the selection, frees a diagnostic hold and voids pending launches", () => {
  const { watches, watch } = watching();
  const reconcile = vi.fn();
  const c = new DiagnosticPageController({ classify: vi.fn(), watch, reconcile });
  c.openLaunched(c.acquire("diagnostic")!, "r1", display);
  c.close();
  c.clearForSession();
  expect(watches[0].dispose).toHaveBeenCalledTimes(1);
  watches[0].done("completed");
  expect(reconcile).not.toHaveBeenCalled();
  expect(c.state).toEqual({ busy: null, selection: { kind: "closed" } });
  const pendingLaunch = c.acquire("diagnostic")!;
  c.clearForSession();
  expect(c.openLaunched(pendingLaunch, "late", display)).toBe(false);
  expect(c.state).toEqual({ busy: null, selection: { kind: "closed" } });
  const load = c.acquire("load")!;
  c.clearForSession();
  expect(c.state.busy).toBe("load");
  c.release(load);
  expect(c.state.busy).toBeNull();
});

it("a classifier rejection becomes unavailable, never load", async () => {
  const c = new DiagnosticPageController({ classify: vi.fn().mockRejectedValue(Error("private")), watch: vi.fn(), reconcile: vi.fn() });
  await c.view("h");
  expect(c.state.selection).toEqual({ kind: "unavailable", runId: "h" });
});

it("notifies subscribers with immutable states and supports unsubscribe", () => {
  const c = new DiagnosticPageController({ classify: vi.fn(), watch: vi.fn(), reconcile: vi.fn() });
  const listener = vi.fn();
  const off = c.subscribe(listener);
  const before = c.state;
  const token = c.acquire("load")!;
  expect(listener).toHaveBeenCalledTimes(1);
  expect(c.state).not.toBe(before);
  expect(Object.isFrozen(c.state)).toBe(true);
  off();
  c.release(token);
  expect(listener).toHaveBeenCalledTimes(1);
});

it("builds a status-only PATCH body", () => {
  for (const status of ["completed", "failed", "stopped"] as const) {
    expect(statusPatchBody(status)).toEqual({ status });
  }
});
