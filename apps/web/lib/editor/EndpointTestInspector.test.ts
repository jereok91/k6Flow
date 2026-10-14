import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EndpointTestInspector } from "./EndpointTestInspector";
import type { EndpointTestClientResult } from "./endpoint-test-client";

function render(result?: EndpointTestClientResult) {
  return renderToStaticMarkup(
    createElement(EndpointTestInspector, { result, onClose() {}, onRetry() {} }),
  );
}

const okResult = (truncated: boolean): EndpointTestClientResult => ({
  kind: "ok",
  result: {
    status: 201,
    timingMs: 12,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyText: '{"ok":true}',
    truncated,
  },
});

it("renders the never-run state in Spanish", () => {
  const html = render();
  expect(html).toContain("Sin resultado");
  expect(html).toContain("Cerrar");
  expect(html).toContain("Reintentar");
});

it("renders outcome, status, timing, headers and body for a successful run", () => {
  const html = render(okResult(false));
  expect(html).toContain("Correcto");
  expect(html).toContain("201");
  expect(html).toContain("12 ms");
  expect(html).toContain("content-type");
  expect(html).toContain("application/json");
  expect(html).toContain("ok");
});

it("shows a visible truncado note only when the body was truncated", () => {
  expect(render(okResult(true))).toContain("truncado");
  expect(render(okResult(false))).not.toContain("truncado");
});

it("renders the Spanish outcome label for a failure", () => {
  const html = render({ kind: "denied", message: "Destino no autorizado" });
  expect(html).toContain("Denegado");
  expect(html).toContain("Destino no autorizado");
});

it.each(["denied", "timeout", "network", "invalid", "session-changed"] as const)(
  "renders the fixed message carried by the %s failure",
  kind => {
    const message = `MENSAJE-${kind}`;
    const html = render({ kind, message } as unknown as EndpointTestClientResult);
    expect(html).toContain(message);
  },
);

it("never offers a copy-as-cURL action", () => {
  const html = render(okResult(false));
  expect(html.toLowerCase()).not.toContain("curl");
});

it("escapes body and header text through React", () => {
  const html = render({
    kind: "ok",
    result: {
      status: 200,
      timingMs: 1,
      headers: [{ name: "x-echo", value: "<script>alert(1)</script>" }],
      bodyText: "<img src=x onerror=alert(1)>",
      truncated: false,
    },
  });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});
