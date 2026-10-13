import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { createDiagnosticPageDeps, useDiagnosticPage } from "./use-diagnostic-page";

const MARKER = "a".repeat(64);
const interrupted = {
  version: 1, runId: "r", status: "stopped", diagnostic: { nodeIds: ["n"] }, trace: { state: "interrupted", events: [] },
};
const running = { ...interrupted, status: "running", trace: { state: "running", events: [] } };

afterEach(() => vi.useRealTimers());

it("classifies without any request when no verified marker exists", async () => {
  const fetcher = vi.fn();
  const deps = createDiagnosticPageDeps({ fetch: fetcher, getMarker: () => null, reconcile: vi.fn() });
  expect(await deps.classify("r", { isCurrent: () => true })).toEqual({ kind: "unavailable", error: "diagnostic-unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("classifies with the session marker header and maps only 409 to load", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(new Response(null, { status: 412 }));
  const deps = createDiagnosticPageDeps({ fetch: fetcher, getMarker: () => MARKER, reconcile: vi.fn() });
  expect((await deps.classify("r", { isCurrent: () => true })).kind).toBe("load");
  expect((await deps.classify("r", { isCurrent: () => true })).kind).toBe("unavailable");
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-K6Flow-Session-Marker")).toBe(MARKER);
});

it("watches a hidden run until terminal and reports its history status once", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(running))
    .mockResolvedValue(Response.json(interrupted));
  const deps = createDiagnosticPageDeps({ fetch: fetcher, getMarker: () => MARKER, reconcile: vi.fn() });
  const done = vi.fn();
  deps.watch("r", done);
  await vi.advanceTimersByTimeAsync(0);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(done).toHaveBeenCalledTimes(1);
  expect(done).toHaveBeenCalledWith("stopped");
  const calls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-K6Flow-Session-Marker")).toBe(MARKER);
});

it("reports an unobservable run (412) or a missing marker as null", async () => {
  vi.useFakeTimers();
  const denied = createDiagnosticPageDeps({
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 412 })), getMarker: () => MARKER, reconcile: vi.fn(),
  });
  const done = vi.fn();
  denied.watch("r", done);
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalledWith(null);
  const fetcher = vi.fn();
  const unverified = createDiagnosticPageDeps({ fetch: fetcher, getMarker: () => "bad", reconcile: vi.fn() });
  const none = vi.fn();
  unverified.watch("r", none);
  expect(none).toHaveBeenCalledWith(null);
  expect(fetcher).not.toHaveBeenCalled();
});

it("stops polling when the watch is disposed", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json(running));
  const deps = createDiagnosticPageDeps({ fetch: fetcher, getMarker: () => MARKER, reconcile: vi.fn() });
  const done = vi.fn();
  const stop = deps.watch("r", done);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const calls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(done).not.toHaveBeenCalled();
});

it("forwards reconcile to the latest page callback", () => {
  const reconcile = vi.fn();
  createDiagnosticPageDeps({ fetch: vi.fn(), getMarker: () => MARKER, reconcile }).reconcile("r", "failed");
  expect(reconcile).toHaveBeenCalledWith("r", "failed");
});

// SSR smoke only: the controller is created in an effect, never on the server.
function Probe() {
  const page = useDiagnosticPage({ getMarker: () => null, reconcile() {} });
  return createElement("output", null, page.controller ? "ready" : "none", ":", page.state.busy ?? "free");
}

it("renders without a controller or browser globals on the server", () => {
  expect(renderToStaticMarkup(createElement(Probe))).toBe("<output>none:free</output>");
});
