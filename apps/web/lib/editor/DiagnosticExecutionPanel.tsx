"use client";

import React, { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { createPanelSelection, resolvePanelSelection, PanelCommitBinding,
  type PanelCallbacks, type PanelInput, type PanelView } from "./diagnostic-panel-lifetime";
import { isDiagnosticTerminal, projectDiagnosticNodes } from "./diagnostic-snapshot";

export interface DiagnosticExecutionPanelProps extends PanelInput, PanelCallbacks {
  onClose(): void;
}

/** Immutable, selection-scoped view; intentionally not wired to page/auth/history. */
export function DiagnosticExecutionPanel(props: DiagnosticExecutionPanelProps) {
  const [stored, setStored] = useState(() => createPanelSelection(props));
  const selection = resolvePanelSelection(stored, props);
  if (selection !== stored) {
    // React-local render adjustment: hide the old scope synchronously, without
    // mutating shared refs. Abandoning this render leaves the committed gate alone.
    setStored(selection);
  }
  const [binding] = useState(() => new PanelCommitBinding());
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    // Every committed render updates callbacks; inline callbacks do not restart HTTP.
    binding.commit(selection, {
      onTerminal: props.onTerminal,
      onProtectedDataInvalidated: props.onProtectedDataInvalidated,
    });
  });
  useLayoutEffect(() => () => binding.clear(selection), [binding, selection]);
  useEffect(() => {
    const active = binding.setup(selection, refresh);
    return () => active?.dispose();
  }, [binding, selection]);
  return <DiagnosticPanelView view={selection.view} onClose={props.onClose}
    onRetry={() => binding.retry(selection)} onStop={() => binding.stop(selection)} />;
}

const traceLabels = {
  pending: "Pendiente", running: "En ejecución", complete: "Éxito",
  failed: "Fallido", incomplete: "Incompleto", interrupted: "Interrumpido",
};
const nodeLabels = {
  unknown: "Sin observación", running: "Entrada observada", success: "Salida exitosa",
  failure: "Salida fallida", skipped: "Omisión observada",
};
const eventLabels = { enter: "Entrada", exit: "Salida", skipped: "Omisión", complete: "Fin de traza" };
const reasonLabels = {
  none: "Sin motivo adicional", disabled: "Deshabilitado", "prior-failure": "Fallo previo",
  http: "HTTP", extraction: "Extracción", check: "Validación", pool: "Datos", exception: "Excepción",
};
const outcomeLabels = { pending: "Pendiente", success: "Éxito", failure: "Fallo", skipped: "Omitido" };

/** The same renderer used by the panel; exported for SSR state verification. */
export function DiagnosticPanelView({ view, onClose, onRetry, onStop }: {
  view: PanelView; onClose(): void; onRetry(): void; onStop(): void;
}) {
  const { observation, snapshot, executionDisplay } = view;
  const forbidden = observation.availability === "forbidden";
  const visibleSnapshot = forbidden ? undefined : snapshot;
  const visibleDisplay = forbidden ? undefined : executionDisplay;
  const terminal = !!visibleSnapshot && isDiagnosticTerminal(visibleSnapshot);
  const blocked = forbidden || terminal;
  const states = visibleSnapshot ? projectDiagnosticNodes(visibleSnapshot) : undefined;
  const ids = visibleSnapshot?.diagnostic.nodeIds ?? visibleDisplay?.map(node => node.id) ?? [];
  const display = new Map(visibleDisplay?.map(node => [node.id, node]));
  return <section aria-label="Ejecución diagnóstica" className="rounded-lg border-2 border-secondary bg-surface-container p-4 text-on-surface">
    <header className="flex items-center justify-between gap-4">
      <h2 className="font-semibold text-secondary">Diagnóstico · separado de la carga</h2>
      <button type="button" onClick={onClose}>Cerrar</button>
    </header>
    <p>Configuración: 1 VU · 1 iteración</p>
    <p>Identificador: {view.runId}</p>
    <p role="status">{forbidden ? "Acceso no autorizado · datos borrados" :
      visibleSnapshot ? traceLabels[visibleSnapshot.trace.state] : "Sin traza verificada"}</p>
    {!forbidden && view.invalidInput && <p>Datos iniciales no válidos · requiere lectura verificada</p>}
    {!forbidden && observation.availability === "loading" && <p>Consultando ejecución</p>}
    {!forbidden && ["stale", "unavailable"].includes(observation.availability) &&
      <p>Lectura no disponible · no confirma el resultado de la ejecución</p>}
    {observation.readUncertain && <p>Lectura sin confirmar · transporte pendiente</p>}
    {observation.stopUncertain && <p>Detención sin confirmar · transporte pendiente</p>}
    {!terminal && !forbidden && observation.stopState === "acknowledged" &&
      <p>Solicitud de detención aceptada · esperando traza terminal</p>}
    {!terminal && !forbidden && observation.stopState === "error" && !observation.stopUncertain &&
      <p>No se pudo confirmar la solicitud de detención</p>}
    <div className="flex gap-4 py-2">
      <button type="button" onClick={onRetry} disabled={blocked || observation.readInFlight}>Reintentar lectura</button>
      <button type="button" onClick={onStop}
        disabled={blocked || observation.stopInFlight || observation.stopState === "acknowledged"}>Detener</button>
    </div>
    <ol className="space-y-2">
      {ids.map(id => {
        const node = display.get(id);
        const state = states?.[id] ?? "unknown";
        return <li key={id} className="rounded border border-outline-variant p-2">
          <span>{node?.label ?? id}</span>{node?.label && <span> · {id}</span>}
          {node?.disabled && <span> · Configurado como deshabilitado</span>}
          <p>{state === "running" && terminal ? "Entrada sin salida observada" : nodeLabels[state]}</p>
        </li>;
      })}
    </ol>
    <h3 className="mt-4 font-semibold">Eventos observados</h3>
    <ol>
      {visibleSnapshot?.trace.events.map(event => <li key={event.seq}>
        {event.seq} · {event.nodeId} · {eventLabels[event.event]} · {outcomeLabels[event.outcome]} · {reasonLabels[event.reason]}
        {event.event === "exit" && <span> · Tiempo registrado: {event.elapsedMs} ms · Estado HTTP: {event.httpStatus}</span>}
      </li>)}
    </ol>
  </section>;
}
