import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { useSessionGuard } from "./use-session-guard";

// SSR smoke test only: Node has no DOM library, so effects (probe creation,
// listeners, StrictMode remount, cleanup) are not executed here. That logic
// lives in the pure controller covered by session-guard.test.ts.
function Probe() {
  const state = useSessionGuard(() => {});
  return createElement("output", null, state.phase);
}

it("renders unknown on the server without touching browser globals", { timeout: 3000 }, () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  expect(renderToStaticMarkup(createElement(Probe))).toBe("<output>unknown</output>");
});
