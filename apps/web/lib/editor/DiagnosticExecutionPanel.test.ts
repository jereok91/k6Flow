import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DiagnosticExecutionPanel, DiagnosticPanelView } from "./DiagnosticExecutionPanel";
import { createPanelSelection } from "./diagnostic-panel-lifetime";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot";
const enter = { seq: 1, nodeId: "n", event: "enter", elapsedMs: 0, httpStatus: 0, outcome: "pending", reason: "none" };
const snapshot = (state = "running", status = "running", events: unknown[] = []) => ({
  version: 1, runId: "a", status, diagnostic: { nodeIds: ["n", "other"] }, trace: { state, events },
});
const base = { runId: "a", selectionKey: 1, onClose() {}, onTerminal() {}, onProtectedDataInvalidated() {} };
function render(initialSnapshot: unknown, executionDisplay?: unknown) {
  return renderToStaticMarkup(createElement(DiagnosticExecutionPanel, {
    ...base, initialSnapshot: initialSnapshot as never, executionDisplay: executionDisplay as never,
  }));
}
it("renders historical IDs, unknown nodes and configuration, not fabricated metrics", () => {
  const html = render(snapshot());
  expect(html).toContain("other");
  expect(html).toContain("Sin observación");
  expect(html).toContain("Configuración: 1 VU · 1 iteración");
  expect(html).not.toMatch(/Promedio|Tasa de error|Completado/);
});
it.each([["incomplete", "finished", "Incompleto"], ["interrupted", "stopped", "Interrumpido"]])(
  "shows unmatched enter without running animation for %s", (state, status, label) => {
    const html = render(snapshot(state, status, [enter]));
    expect(html).toContain(label);
    expect(html).toContain("Entrada sin salida observada");
    expect(html).not.toContain("animate-");
    expect(html).not.toContain("Éxito");
  },
);
it("escapes labels and only displays minimal fields, not parameters or raw errors", () => {
  const html = render(snapshot(), [
    { id: "n", kind: "http-request", label: "<script>secret</script>", disabled: false, parameters: { password: "RAW_PRIVATE" } },
    { id: "other", kind: "http-request", disabled: false },
  ]);
  expect(html).toContain("&lt;script&gt;secret&lt;/script&gt;");
  expect(html).not.toContain("RAW_PRIVATE");
  expect(html).not.toContain("<script>");
});
it.each([ { ...snapshot(), runId: "wrong" }, { ...snapshot(), diagnostic: { nodeIds: ["wrong"] } }, { invalid: "RAW_PRIVATE" } ])(
  "does not render misbound or malformed initial trace", initial => {
    const html = render(initial, [{ id: "n", kind: "http-request", disabled: false }, { id: "other", kind: "http-request", disabled: false }]);
    expect(html).not.toContain("wrong");
    expect(html).not.toContain("RAW_PRIVATE");
    expect(html).not.toContain("Sin observación");
    expect(html).toContain("Sin traza verificada");
  },
);
it("renders pending transport uncertainty and disables operations, but never Close", () => {
  const selection = createPanelSelection({ ...base, initialSnapshot: snapshot() as never });
  const view = { ...selection.view, observation: { ...selection.view.observation,
    readInFlight: true, stopInFlight: true, readUncertain: true, stopUncertain: true } };
  const html = renderToStaticMarkup(createElement(DiagnosticPanelView, { view, onClose() {}, onRetry() {}, onStop() {} }));
  expect(html).toContain("Lectura sin confirmar");
  expect(html).toContain("Detención sin confirmar");
  expect(html).toMatch(/disabled="">Reintentar lectura/);
  expect(html).toMatch(/disabled="">Detener/);
  const close = html.match(/<button[^>]*>Cerrar<\/button>/)?.[0];
  expect(close).toBeDefined();
  expect(close).not.toContain("disabled");
});

it.each(["success", "failure"])("renders authoritative %s completion and exit-only timing/status", outcome => {
  const events = [enter,
    { ...enter, seq: 2, event: "exit", elapsedMs: 12, httpStatus: 201, outcome, reason: outcome === "failure" ? "check" : "none" },
    { ...enter, seq: 3, nodeId: "other", event: "skipped", outcome: "skipped", reason: outcome === "failure" ? "prior-failure" : "disabled" },
    { ...enter, seq: 4, nodeId: "", event: "complete", outcome, reason: outcome === "failure" ? "prior-failure" : "none" },
  ];
  const html = render(snapshot(outcome === "success" ? "complete" : "failed", "finished", events));
  expect(html).toContain(outcome === "success" ? "Éxito" : "Fallido");
  expect(html).toContain("Tiempo registrado: 12 ms");
  expect(html).toContain("Estado HTTP: 201");
  expect(html.match(/Tiempo registrado/g)).toHaveLength(1);
  expect(html).not.toContain("Tiempo registrado: 0");
  expect(html).toMatch(/disabled="">Reintentar lectura/);
  expect(html).toMatch(/disabled="">Detener/);
});

it.each(["acknowledged", "forbidden"])("disables Stop for %s and hides protected data for forbidden", mode => {
  const selection = createPanelSelection({ ...base, initialSnapshot: parseDiagnosticSnapshot(snapshot(), "a"),
    executionDisplay: [
      { id: "n", kind: "http-request", label: "PRIVATE_LABEL", disabled: false, position: undefined },
      { id: "other", kind: "http-request", label: undefined, disabled: false, position: undefined },
    ],
  });
  const observation = { ...selection.view.observation,
    availability: mode === "forbidden" ? "forbidden" as const : "available" as const,
    stopState: mode === "acknowledged" ? "acknowledged" as const : undefined,
  };
  const html = renderToStaticMarkup(createElement(DiagnosticPanelView, {
    view: { ...selection.view, observation }, onClose() {}, onRetry() {}, onStop() {},
  }));
  expect(html).toMatch(/disabled="">Detener/);
  if (mode === "forbidden") {
    expect(html).not.toContain("PRIVATE_LABEL");
    expect(html).not.toContain("other");
    expect(html).toMatch(/disabled="">Reintentar lectura/);
  } else {
    expect(html).toContain("esperando traza terminal");
    expect(html).toContain("PRIVATE_LABEL");
  }
});
