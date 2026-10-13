import { expect, it, vi } from "vitest";
import { isSessionMarker, SESSION_MARKER_HEADER, withSessionMarker } from "./session-marker-header";

const LIVE = "a".repeat(64);

it("accepts only lowercase 64-hex markers", () => {
  expect(isSessionMarker(LIVE)).toBe(true);
  for (const bad of [undefined, null, 1, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    expect(isSessionMarker(bad)).toBe(false);
  }
});

it("adds the marker header and keeps the caller's headers and init", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null));
  const signal = new AbortController().signal;
  await withSessionMarker(fetcher, LIVE)("/x", { method: "POST", signal, headers: { Accept: "application/json" } });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("/x");
  expect(init.method).toBe("POST");
  expect(init.signal).toBe(signal);
  const headers = new Headers(init.headers);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get(SESSION_MARKER_HEADER)).toBe(LIVE);
});

it("overrides a caller-supplied marker header", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null));
  await withSessionMarker(fetcher, LIVE)("/x", { headers: { [SESSION_MARKER_HEADER]: "b".repeat(64) } });
  expect(new Headers(fetcher.mock.calls[0][1].headers).get(SESSION_MARKER_HEADER)).toBe(LIVE);
});

it("refuses an invalid marker without wrapping", () => {
  expect(() => withSessionMarker(vi.fn(), "A".repeat(64))).toThrow("Invalid session marker");
});
