"use client";

import React from "react";
import type { EndpointTestClientResult } from "./endpoint-test-client";

export interface EndpointTestInspectorProps {
  /** Last memory-only result for this node, or nothing when it was never run. */
  readonly result?: EndpointTestClientResult;
  onClose(): void;
  onRetry(): void;
}

const outcomeLabels: Readonly<Record<EndpointTestClientResult["kind"], string>> = {
  ok: "Correcto",
  denied: "Denegado",
  timeout: "Tiempo agotado",
  network: "Sin conexión",
  invalid: "No válido",
  unavailable: "No disponible",
  "session-changed": "Sesión cambiada",
};

/** Presentational Spanish panel for the last endpoint-test result. */
export function EndpointTestInspector({ result, onClose, onRetry }: EndpointTestInspectorProps) {
  return (
    <section
      aria-label="Resultado de la prueba de endpoint"
      className="rounded-lg border-2 border-secondary bg-surface-container p-4 text-on-surface"
    >
      <header className="flex items-center justify-between gap-4">
        <h2 className="font-semibold text-secondary">Prueba de endpoint · destino permitido</h2>
        <button type="button" onClick={onClose}>Cerrar</button>
      </header>
      {result === undefined ? (
        <p>Sin resultado · la prueba aún no se ejecutó</p>
      ) : (
        <EndpointTestResultView result={result} />
      )}
      <div className="flex gap-4 py-2">
        <button type="button" onClick={onRetry}>Reintentar</button>
      </div>
    </section>
  );
}

/** Exported so SSR tests can exercise a result without the panel chrome. */
export function EndpointTestResultView({ result }: { result: EndpointTestClientResult }) {
  const label = outcomeLabels[result.kind];
  if (result.kind !== "ok") {
    return (
      <div>
        <p role="status">{label}</p>
        {/* Fixed per-kind message; server text is never rendered here. */}
        <p>{result.message}</p>
      </div>
    );
  }
  const { status, timingMs, headers, bodyText, truncated } = result.result;
  return (
    <div>
      <p role="status">{label}</p>
      <p>Estado HTTP: {status} · Tiempo: {timingMs} ms</p>
      <h3 className="mt-4 font-semibold">Headers devueltos</h3>
      {headers.length === 0 ? (
        <p>Sin headers devueltos</p>
      ) : (
        <ul>
          {headers.map((header, index) => (
            <li key={`${index}-${header.name}`}>{header.name}: {header.value}</li>
          ))}
        </ul>
      )}
      <h3 className="mt-4 font-semibold">Vista previa del cuerpo</h3>
      <pre className="whitespace-pre-wrap break-words">{bodyText}</pre>
      {truncated && <p>Contenido truncado · vista previa limitada al límite permitido</p>}
    </div>
  );
}
