import { afterEach, expect, it, vi } from "vitest";
import { createPanelSelection, PanelCommitBinding, resolvePanelSelection, setupPanelLifetime } from "./diagnostic-panel-lifetime";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot";

const running = {
  version: 1, runId: "a", status: "running",
  diagnostic: { nodeIds: ["n"] }, trace: { state: "running", events: [] },
};
const terminal = { ...running, status: "finished", trace: { state: "incomplete", events: [] } };
function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const callbacks = () => ({ onTerminal: vi.fn(), onProtectedDataInvalidated: vi.fn() });
afterEach(() => vi.useRealTimers());

it("replays setup with a NEW observer, observes initial data and deduplicates terminal per selection", async () => {
  vi.useFakeTimers();
  const selection = createPanelSelection({ runId: "a", selectionKey: 1, initialSnapshot: parseDiagnosticSnapshot(terminal, "a") });
  const fetcher = vi.fn(() => Promise.resolve(Response.json(terminal)));
  const cb = callbacks();
  const first = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher });
  expect(cb.onTerminal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  first.dispose();
  const second = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  expect(first.observer).not.toBe(second.observer);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(cb.onTerminal).toHaveBeenCalledExactlyOnceWith({ runId: "a", status: "failed" });
  second.dispose();
  const newSelection = createPanelSelection({ runId: "a", selectionKey: 2 });
  const third = setupPanelLifetime(newSelection, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onTerminal).toHaveBeenCalledTimes(2);
  third.dispose();
});

it("guards old A after A→B→A, disposal, and callback updates without restarting requests", async () => {
  vi.useFakeTimers();
  const old = deferred();
  const fresh = deferred();
  const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  let current = createPanelSelection({ runId: "a", selectionKey: 1 });
  const a = current;
  let cb = callbacks();
  const original = cb;
  const first = setupPanelLifetime(a, () => current === a, () => cb, vi.fn(), { fetch: fetcher });
  current = createPanelSelection({ runId: "b", selectionKey: 2 });
  current = createPanelSelection({ runId: "a", selectionKey: 3 });
  const next = current;
  const second = setupPanelLifetime(next, () => current === next, () => cb, vi.fn(), { fetch: fetcher });
  cb = callbacks();
  old.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(next.view.snapshot).toBeUndefined();
  expect(a.view.snapshot).toBeUndefined();
  expect(original.onTerminal).not.toHaveBeenCalled();
  fresh.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  first.dispose(); second.dispose();
});

it("erases snapshot AND display before forbidden callback; drain republishes cannot notify twice", async () => {
  vi.useFakeTimers();
  const selection = createPanelSelection({ runId: "a", selectionKey: 1,
    initialSnapshot: parseDiagnosticSnapshot(running, "a"),
    executionDisplay: [{ id: "n", kind: "http-request", label: "private", disabled: false, position: undefined }],
  });
  const cb = callbacks();
  cb.onProtectedDataInvalidated.mockImplementation(() => {
    expect(selection.view.snapshot).toBeUndefined();
    expect(selection.view.executionDisplay).toBeUndefined();
  });
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), {
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onProtectedDataInvalidated).toHaveBeenCalledTimes(1);
  life.observer.retry();
  await life.observer.stop();
  expect(cb.onTerminal).not.toHaveBeenCalled();
  life.dispose();
});

it("keeps ignored-abort reads pending and uncertain until physical drain, ignoring late 403", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const fetcher = vi.fn().mockReturnValue(pending.promise);
  const selection = createPanelSelection({ runId: "a", selectionKey: 1 });
  const cb = callbacks();
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher, timeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  expect(selection.view.observation.readUncertain).toBe(true);
  life.observer.retry();
  expect(fetcher).toHaveBeenCalledTimes(1);
  pending.resolve(new Response(null, { status: 403 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(selection.view.observation.readInFlight).toBe(false);
  expect(cb.onProtectedDataInvalidated).not.toHaveBeenCalled();
  life.dispose();
});

it("does not report a Stop acknowledgement as terminal and continues owned reads", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(running))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json(terminal));
  const selection = createPanelSelection({ runId: "a", selectionKey: 1 });
  const cb = callbacks();
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher, intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  await life.observer.stop();
  expect(selection.view.observation.stopState).toBe("acknowledged");
  expect(cb.onTerminal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
  expect(fetcher.mock.calls[1][0]).toContain("/stop");
  life.dispose();
});

it.each(["403", "500", "rejection"])("handles current Stop %s after terminal without false failure or duplicate receipt", async result => {
  vi.useFakeTimers();
  const stopping = deferred();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(running))
    .mockReturnValueOnce(stopping.promise)
    .mockResolvedValueOnce(Response.json(terminal));
  const selection = createPanelSelection({ runId: "a", selectionKey: 1,
    executionDisplay: [{ id: "n", kind: "http-request", label: "private", disabled: false, position: undefined }],
  });
  const cb = callbacks();
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher, intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  const stop = life.observer.stop();
  await vi.advanceTimersByTimeAsync(10);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  if (result === "rejection") stopping.reject(new Error("RAW_PRIVATE"));
  else stopping.resolve(new Response(null, { status: Number(result) }));
  await stop;
  await vi.advanceTimersByTimeAsync(0);
  if (result === "403") {
    expect(cb.onProtectedDataInvalidated).toHaveBeenCalledTimes(1);
    expect(selection.view.snapshot).toBeUndefined();
    expect(selection.view.executionDisplay).toBeUndefined();
  } else {
    expect(selection.view.observation.stopState).toBeUndefined();
    expect(selection.view.snapshot?.trace.state).toBe("incomplete");
  }
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  life.dispose();
});

it("keeps forever abort-ignoring Stop pending; late 403 cannot erase and requires external invalidation", async () => {
  vi.useFakeTimers();
  const stopping = deferred();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(running)).mockReturnValueOnce(stopping.promise);
  const selection = createPanelSelection({ runId: "a", selectionKey: 1 });
  const cb = callbacks();
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher, timeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  const stop = life.observer.stop();
  await vi.advanceTimersByTimeAsync(10);
  await stop;
  expect(selection.view.observation.stopUncertain).toBe(true);
  expect(selection.view.observation.stopInFlight).toBe(true);
  await life.observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(2);
  stopping.resolve(new Response(null, { status: 403 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onProtectedDataInvalidated).not.toHaveBeenCalled();
  expect(selection.view.snapshot).toBeDefined();
  life.dispose();
});

it("disposal never emits terminal or protected-data callbacks for old requests", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const selection = createPanelSelection({ runId: "a", selectionKey: 1 });
  const cb = callbacks();
  const update = vi.fn();
  const life = setupPanelLifetime(selection, () => true, () => cb, update, { fetch: () => pending.promise });
  life.dispose();
  const calls = update.mock.calls.length;
  pending.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenCalledTimes(calls);
  expect(cb.onTerminal).not.toHaveBeenCalled();
  expect(cb.onProtectedDataInvalidated).not.toHaveBeenCalled();
});

it("refuses regressive reads against validated initial data and compiler IDs", async () => {
  vi.useFakeTimers();
  const selection = createPanelSelection({ runId: "a", selectionKey: 1,
    initialSnapshot: parseDiagnosticSnapshot(terminal, "a"),
  });
  const cb = callbacks();
  const life = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), {
    fetch: vi.fn().mockResolvedValue(Response.json(running)),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(selection.view.snapshot?.trace.state).toBe("incomplete");
  expect(selection.view.invalidInput).toBe(true);
  expect(cb.onTerminal).not.toHaveBeenCalled();
  life.dispose();
});

it("keeps selection stable for inline metadata copies and owns minimal immutable data", () => {
  const node = { id: "n", kind: "http-request" as const, label: "original", disabled: false, position: undefined,
    parameters: { password: "RAW_PRIVATE" } };
  const input = { runId: "a", selectionKey: 1, executionDisplay: [node] };
  const selection = createPanelSelection(input);
  const copied = { ...input, executionDisplay: [{ ...node, label: "live graph change" }] };
  expect(resolvePanelSelection(selection, copied)).toBe(selection);
  node.label = "mutated";
  expect(selection.view.executionDisplay?.[0].label).toBe("original");
  expect(JSON.stringify(selection.view.executionDisplay)).not.toContain("RAW_PRIVATE");
  expect(Object.isFrozen(selection.view.executionDisplay)).toBe(true);
  expect(Object.isFrozen(selection.view.executionDisplay?.[0])).toBe(true);
});

it("latches denial across display removal, changed IDs, replayed initial snapshot and setup replay", async () => {
  vi.useFakeTimers();
  const input = { runId: "a", selectionKey: 1,
    initialSnapshot: parseDiagnosticSnapshot(running, "a"),
    executionDisplay: [{ id: "n", kind: "http-request" as const, label: "private", disabled: false, position: undefined }],
  };
  let selection = createPanelSelection(input);
  const denied = selection;
  const cb = callbacks();
  const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
  const first = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  expect(selection.protectedDataInvalidated).toBe(true);
  first.dispose();
  for (const executionDisplay of [undefined, [{ ...input.executionDisplay[0], id: "changed" }], input.executionDisplay]) {
    selection = resolvePanelSelection(selection, { ...input, executionDisplay });
    expect(selection.view.snapshot).toBeUndefined();
    expect(selection.view.executionDisplay).toBeUndefined();
    expect(selection).toBe(denied);
    expect(selection.expectedIds).toBeUndefined();
    const replay = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher });
    await vi.advanceTimersByTimeAsync(0);
    replay.dispose();
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cb.onProtectedDataInvalidated).toHaveBeenCalledTimes(1);
  expect(cb.onTerminal).not.toHaveBeenCalled();
  const fresh = resolvePanelSelection(selection, { ...input, selectionKey: 2 });
  expect(fresh).not.toBe(denied);
  expect(fresh.view.snapshot?.runId).toBe("a");
  expect(fresh.protectedDataInvalidated).toBe(false);
  const next = setupPanelLifetime(fresh, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(cb.onProtectedDataInvalidated).toHaveBeenCalledTimes(2);
  next.dispose();
});

it("keeps first metadata and terminal receipt across same-scope input changes", async () => {
  vi.useFakeTimers();
  const input = { runId: "a", selectionKey: 1,
    executionDisplay: [{ id: "n", kind: "http-request" as const, label: "captured", disabled: false, position: undefined }],
  };
  const selection = createPanelSelection(input);
  const cb = callbacks();
  const fetcher = vi.fn(() => Promise.resolve(Response.json(terminal)));
  const first = setupPanelLifetime(selection, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  first.dispose();
  const same = resolvePanelSelection(selection, { ...input, executionDisplay: [{ ...input.executionDisplay[0], id: "live", label: "current graph" }] });
  expect(same).toBe(selection);
  expect(same.view.executionDisplay?.[0].label).toBe("captured");
  const replay = setupPanelLifetime(same, () => true, () => cb, vi.fn(), { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  replay.dispose();
  const newRun = resolvePanelSelection(selection, { ...input, runId: "b" });
  expect(newRun).not.toBe(selection);
});

it("candidate scope/callback preparation cannot suppress or redirect committed observations", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const fetcher = vi.fn(() => pending.promise);
  const a = createPanelSelection({ runId: "a", selectionKey: 1 });
  const cb = callbacks();
  const abandoned = callbacks();
  const gate = new PanelCommitBinding();
  gate.commit(a, cb);
  const active = gate.setup(a, vi.fn(), { fetch: fetcher })!;
  const candidate = resolvePanelSelection(a, { runId: "b", selectionKey: 2 });
  expect(gate.setup(candidate, vi.fn(), { fetch: fetcher })).toBeUndefined();
  gate.retry(candidate);
  gate.stop(candidate);
  pending.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(a.view.snapshot?.trace.state).toBe("incomplete");
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  expect(abandoned.onTerminal).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(resolvePanelSelection(a, { runId: "a", selectionKey: 1 })).toBe(a);
  active.dispose();
  gate.clear(a);
});

it("commits callback updates without restart; controls require the committed active lifetime", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const fetcher = vi.fn(() => pending.promise);
  const a = createPanelSelection({ runId: "a", selectionKey: 1 });
  const gate = new PanelCommitBinding();
  const old = callbacks();
  const fresh = callbacks();
  gate.retry(a);
  gate.stop(a);
  expect(gate.setup(a, vi.fn(), { fetch: fetcher })).toBeUndefined();
  gate.commit(a, old);
  gate.retry(a);
  gate.stop(a);
  expect(fetcher).not.toHaveBeenCalled();
  const active = gate.setup(a, vi.fn(), { fetch: fetcher })!;
  gate.commit(resolvePanelSelection(a, { runId: "a", selectionKey: 1 }), fresh);
  expect(fetcher).toHaveBeenCalledTimes(1);
  pending.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(old.onTerminal).not.toHaveBeenCalled();
  expect(fresh.onTerminal).toHaveBeenCalledTimes(1);
  active.dispose();
  gate.clear(a);
});

it("commit/cleanup isolate A→B→A and stale controls, callbacks, and physical drains", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  const gate = new PanelCommitBinding();
  const cb = callbacks();
  const a = createPanelSelection({ runId: "a", selectionKey: 1 });
  gate.commit(a, cb);
  const oldA = gate.setup(a, vi.fn(), { fetch: fetcher })!;
  const b = resolvePanelSelection(a, { runId: "b", selectionKey: 2 });
  gate.clear(a);
  gate.commit(b, cb);
  gate.retry(a);
  gate.stop(a);
  gate.retry(b);
  gate.stop(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const oldB = gate.setup(b, vi.fn(), { fetch: fetcher })!;
  const nextA = resolvePanelSelection(b, { runId: "a", selectionKey: 3 });
  gate.clear(b);
  gate.commit(nextA, cb);
  const live = gate.setup(nextA, vi.fn(), { fetch: fetcher })!;
  // Old passive cleanup cannot tear down a newer installed lifetime.
  oldA.dispose(); oldB.dispose(); gate.clear(b);
  first.resolve(Response.json(terminal));
  second.resolve(new Response(null, { status: 403 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(nextA.view.snapshot).toBeUndefined();
  expect(cb.onTerminal).not.toHaveBeenCalled();
  expect(cb.onProtectedDataInvalidated).not.toHaveBeenCalled();
  third.resolve(Response.json(terminal));
  await vi.advanceTimersByTimeAsync(0);
  expect(nextA.view.snapshot?.trace.state).toBe("incomplete");
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(3);
  live.dispose(); gate.clear(nextA);
});

it("commit gate cleanup/setup replay preserves denial and terminal receipts", async () => {
  vi.useFakeTimers();
  const gate = new PanelCommitBinding();
  const cb = callbacks();
  const a = createPanelSelection({ runId: "a", selectionKey: 1 });
  const fetcher = vi.fn(() => Promise.resolve(Response.json(terminal)));
  gate.commit(a, cb);
  const first = gate.setup(a, vi.fn(), { fetch: fetcher })!;
  await vi.advanceTimersByTimeAsync(0);
  gate.clear(a); first.dispose();
  gate.commit(a, cb);
  const replay = gate.setup(a, vi.fn(), { fetch: fetcher })!;
  await vi.advanceTimersByTimeAsync(0);
  expect(cb.onTerminal).toHaveBeenCalledTimes(1);
  gate.clear(a); replay.dispose();
  const denied = resolvePanelSelection(a, { runId: "a", selectionKey: 2 });
  const denyFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
  gate.commit(denied, cb);
  gate.setup(denied, vi.fn(), { fetch: denyFetch });
  await vi.advanceTimersByTimeAsync(0);
  gate.clear(denied);
  gate.commit(resolvePanelSelection(denied, { runId: "a", selectionKey: 2 }), cb);
  gate.setup(denied, vi.fn(), { fetch: denyFetch });
  gate.retry(denied); gate.stop(denied);
  await vi.advanceTimersByTimeAsync(0);
  expect(denyFetch).toHaveBeenCalledTimes(1);
  expect(cb.onProtectedDataInvalidated).toHaveBeenCalledTimes(1);
  expect(denied.expectedIds).toBeUndefined();
  gate.clear(denied);
});
