"use client";

/**
 * Save form: scenario name, step gap, HAR timings, placeholder rewriting, the
 * submit button, the two guards that explain why it is disabled and the result
 * card of the scenario the import created.
 *
 * Nothing here talks to the API: the form calls `onSubmit` and the page owns the
 * request and the resulting state.
 */

import type { FormEvent } from "react";
import type { PreviewSummary } from "../../../lib/import/har-preview";
import { HarImportResultCard } from "./HarImportResultCard";
import type { ImportedScenario, PreviewState } from "./types";

interface HarSaveScenarioFormProps {
  scenarioName: string;
  onScenarioNameChange: (value: string) => void;
  stepGapMs: string;
  onStepGapMsChange: (value: string) => void;
  useHarTimings: boolean;
  onUseHarTimingsChange: (value: boolean) => void;
  applySuggestedVariables: boolean;
  onApplySuggestedVariablesChange: (value: boolean) => void;
  /** The client-side preview: suggestions gate the placeholders toggle, their
   * count is the badge and the steps are the estimate. */
  preview: PreviewState;
  /** Counters of the current selection. */
  summary: PreviewSummary;
  /** Rows selected, as the page computes them. */
  keepCount: number;
  /** Whether the page would accept the submit. */
  canSubmit: boolean;
  isSubmitting: boolean;
  submitError: string | null;
  result: ImportedScenario | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function HarSaveScenarioForm({
  scenarioName,
  onScenarioNameChange,
  stepGapMs,
  onStepGapMsChange,
  useHarTimings,
  onUseHarTimingsChange,
  applySuggestedVariables,
  onApplySuggestedVariablesChange,
  preview,
  summary,
  keepCount,
  canSubmit,
  isSubmitting,
  submitError,
  result,
  onSubmit,
}: HarSaveScenarioFormProps) {
  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-space-md">
      <h2 className="text-headline-sm text-on-surface font-medium">Guardar escenario</h2>

      <div>
        <label className="block text-body-sm text-on-surface-variant mb-space-sm">
          Nombre del escenario
        </label>
        <input
          type="text"
          value={scenarioName}
          onChange={(event) => onScenarioNameChange(event.target.value)}
          placeholder="ej: Flujo de checkout importado"
          className="input"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md items-end">
        <div>
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Separación entre pasos (ms)
          </label>
          <input
            type="number"
            min={0}
            value={stepGapMs}
            onChange={(event) => onStepGapMsChange(event.target.value)}
            className="input"
          />
        </div>
        <label className="flex items-center gap-space-sm text-body-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={useHarTimings}
            onChange={(event) => onUseHarTimingsChange(event.target.checked)}
          />
          Respetar los tiempos del HAR
        </label>
      </div>

      <label className="flex items-start gap-space-sm text-body-sm text-on-surface-variant">
        <input
          type="checkbox"
          checked={applySuggestedVariables}
          onChange={(event) => onApplySuggestedVariablesChange(event.target.checked)}
          disabled={preview.suggestions.length === 0}
          className="mt-0.5"
        />
        <span>
          Aplicar los placeholders <span className="font-mono">{"{{nombre}}"}</span> de las
          variables sugeridas al grafo guardado
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-space-md text-body-sm text-on-surface-variant">
        <span className="badge-success">{summary.kept} a importar</span>
        <span className="badge-warning">{summary.dropped} descartadas</span>
        <span className="font-mono">~{preview.steps} pasos</span>
      </div>

      {summary.origins.length > 0 && (
        <p className="text-label-code-sm text-on-surface-variant font-mono">
          {summary.origins.join(" · ")}
        </p>
      )}

      {submitError !== null && (
        <div className="p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm">
          <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle" aria-hidden="true">
            error
          </span>
          {submitError}
        </div>
      )}

      <button type="submit" disabled={!canSubmit} className="btn-primary justify-center">
        {isSubmitting ? (
          <>
            <div className="animate-spin w-4 h-4 border-2 border-on-primary-container border-t-transparent rounded-full" />
            <span>Importando...</span>
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">save</span>
            <span>Importar {summary.kept} peticiones</span>
          </>
        )}
      </button>

      {keepCount === 0 && (
        <p className="text-body-sm text-on-surface-variant">
          Marca al menos una petición de la tabla para continuar.
        </p>
      )}
      {scenarioName.trim().length === 0 && (
        <p className="text-body-sm text-on-surface-variant">
          El escenario necesita un nombre.
        </p>
      )}

      <HarImportResultCard result={result} />
    </form>
  );
}
