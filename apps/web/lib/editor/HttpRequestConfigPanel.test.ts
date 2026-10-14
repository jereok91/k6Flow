import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  HttpRequestConfigPanel,
  collectReferences,
  collectSampleValues,
  runEndpointTestWithSamples,
} from "./HttpRequestConfigPanel";
import type { EndpointTestClientResult } from "./endpoint-test-client";

// The panel's parameters are loosely typed from the page; these fixtures mirror the
// real graph shape (schema slots holding either a literal or a producer reference).
const referencedParams = {
  method: "POST",
  url: { kind: "reference", reference: { producerNodeId: "auth1", output: "token" } },
  headers: [
    {
      name: "Authorization",
      value: { kind: "reference", reference: { producerNodeId: "auth1", output: "token" } },
    },
    { name: "X-Literal", value: { kind: "literal", value: "plain" } },
  ],
  body: { kind: "json", value: { kind: "literal", value: '{"a":1}' } },
} as const;

const literalParams = {
  method: "GET",
  url: { kind: "literal", value: "https://api.example.com" },
  headers: [{ name: "X-Literal", value: { kind: "literal", value: "plain" } }],
  body: { kind: "none" },
} as const;

const okResult: EndpointTestClientResult = {
  kind: "ok",
  result: {
    status: 204,
    timingMs: 8,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyText: '{"ok":true}',
    truncated: false,
  },
};

function render(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(HttpRequestConfigPanel, {
      parameters: literalParams as never,
      onChange() {},
      onClose() {},
      ...props,
    }),
  );
}

it("collects one entry per distinct reference with a producerNodeId:output key and skips literals", () => {
  expect(collectReferences(referencedParams as never)).toEqual([
    { key: "auth1:token", label: "auth1.token" },
  ]);
});

it("returns no references for literal-only or absent parameters", () => {
  expect(collectReferences(literalParams as never)).toEqual([]);
  expect(collectReferences(undefined)).toEqual([]);
});

it("keeps only the sample values typed for a known reference", () => {
  const references = [{ key: "auth1:token", label: "auth1.token" }];
  expect(
    collectSampleValues(references, { "auth1:token": "Bearer abc", "ghost:out": "nope" }),
  ).toEqual({ "auth1:token": "Bearer abc" });
  expect(collectSampleValues(references, {})).toEqual({});
});

it("calls the run callback with the typed sample values and refuses while running", () => {
  const references = [{ key: "auth1:token", label: "auth1.token" }];
  const calls: Record<string, string>[] = [];
  runEndpointTestWithSamples(references, { "auth1:token": "Bearer abc" }, false, (samples) => {
    calls.push({ ...samples });
  });
  expect(calls).toEqual([{ "auth1:token": "Bearer abc" }]);
  // The same click while a test is in flight must not start another one.
  runEndpointTestWithSamples(references, { "auth1:token": "Bearer abc" }, true, (samples) => {
    calls.push({ ...samples });
  });
  expect(calls).toHaveLength(1);
  // No callback wired (the other panels that reuse this component) is a no-op.
  expect(() => runEndpointTestWithSamples(references, {}, false, undefined)).not.toThrow();
});

it("renders its existing content and no endpoint-test section when the new props are absent", () => {
  const html = render();
  expect(html).toContain("HTTP Request");
  expect(html).toContain("Import from cURL");
  expect(html).toContain("Method");
  expect(html).toContain("URL");
  expect(html).toContain("Headers");
  expect(html).toContain("Body");
  expect(html).not.toContain("Probar endpoint");
  expect(html).not.toContain("Prueba de endpoint");
});

it("renders one labeled sample input per reference and the run button", () => {
  const html = render({
    parameters: referencedParams,
    onRunEndpointTest() {},
  });
  expect(html).toContain("Probar endpoint");
  expect(html).toContain("auth1.token");
  expect(html.match(/placeholder="Valor de muestra"/g)).toHaveLength(1);
});

it("renders no sample input when the node has no references", () => {
  const html = render({ parameters: literalParams, onRunEndpointTest() {} });
  expect(html).toContain("Probar endpoint");
  expect(html).not.toContain("Valor de muestra");
});

it("disables the run button while a test is in flight", () => {
  const inFlight = render({
    parameters: literalParams,
    onRunEndpointTest() {},
    endpointTestRunning: true,
  });
  expect(inFlight.match(/<button[^>]*>Probar endpoint/)![0]).toContain('disabled=""');
  const idle = render({
    parameters: literalParams,
    onRunEndpointTest() {},
    endpointTestRunning: false,
  });
  expect(idle.match(/<button[^>]*>Probar endpoint/)![0]).not.toContain('disabled=""');
});

it("renders the last result for this node, with a dismiss action when offered", () => {
  const html = render({
    parameters: literalParams,
    onRunEndpointTest() {},
    endpointTestResult: okResult,
    onDismissEndpointTestResult() {},
  });
  expect(html).toContain("Correcto");
  expect(html).toContain("204");
  expect(html).toContain("8 ms");
  expect(html).toContain("Descartar resultado");
});

it("renders a failure result and omits the dismiss action when none was given", () => {
  const html = render({
    parameters: literalParams,
    onRunEndpointTest() {},
    endpointTestResult: { kind: "denied", message: "Destino no autorizado" },
  });
  expect(html).toContain("Denegado");
  expect(html).toContain("Destino no autorizado");
  expect(html).not.toContain("Descartar resultado");
});
