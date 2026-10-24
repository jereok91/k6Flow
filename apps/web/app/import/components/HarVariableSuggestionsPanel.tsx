"use client";

/**
 * Suggested variables panel: what the preview found in the kept requests, plus
 * the warnings the importer produced for them.
 */

import type { PreviewState } from "./types";

const MAX_WARNINGS_SHOWN = 8;

interface HarVariableSuggestionsPanelProps {
  /** Preview of the pruned HAR, computed by the page. */
  preview: PreviewState;
}

export function HarVariableSuggestionsPanel({ preview }: HarVariableSuggestionsPanelProps) {
  return (
    <section className="card flex flex-col gap-space-md" aria-labelledby="suggested-variables">
      <div className="flex items-center justify-between gap-space-md">
        <h2 id="suggested-variables" className="text-headline-sm text-on-surface font-medium">
          Variables sugeridas
        </h2>
        <span className="badge-success">{preview.suggestions.length}</span>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        Valores repartidos por todas las peticiones que conviene convertir en variables para
        reutilizar el escenario en otros entornos.
      </p>

      {preview.error !== null ? (
        <p className="text-body-sm text-error">{preview.error}</p>
      ) : preview.suggestions.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant">
          No se detectaron valores repetidos que merezcan una variable.
        </p>
      ) : (
        <ul className="flex flex-col gap-space-sm">
          {preview.suggestions.map((suggestion) => (
            <li
              key={suggestion.name}
              className="flex flex-wrap items-center gap-space-sm p-space-md rounded-lg bg-surface-container-lowest border border-surface-container"
            >
              <span className="font-mono text-body-sm text-on-surface">
                {`{{${suggestion.name}}}`}
              </span>
              <span className={`${suggestion.secret ? "badge-warning" : "badge-success"}`}>
                {suggestion.secret ? "secreto" : "no secreto"}
              </span>
              <span className="text-label-code-sm text-on-surface-variant uppercase">
                {suggestion.kind}
              </span>
              <span className="text-label-code-sm text-on-surface-variant font-mono">
                {suggestion.reasonCode}
              </span>
              <span className="text-label-code-sm text-on-surface-variant w-full">
                {suggestion.occurrences} peticiones · {suggestion.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {preview.warnings.length > 0 && (
        <div className="flex flex-col gap-space-xs">
          <span className="text-body-sm text-on-surface-variant">Avisos del importador</span>
          <ul className="flex flex-col gap-space-xs">
            {preview.warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning, position) => (
              <li key={`${position}-${warning}`} className="text-label-code-sm text-on-surface-variant">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
