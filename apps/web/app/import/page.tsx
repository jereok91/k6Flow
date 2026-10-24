"use client";

/**
 * HAR import screen (T8b/D7/D8/D9).
 *
 * The file never leaves the browser until the user confirms: the page reads the
 * `.har`, classifies and filters it with the shared modules, prunes it to the
 * checked requests and only then posts the reduced HAR to `/api/import/har`.
 * Filtering, selection and the variable preview are memoised so typing in a
 * filter recomputes the table (and nothing else), and only the confirm button
 * performs a request.
 */

import { useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import Link from "next/link";
import {
  HAR_RESOURCE_TYPES,
  harGraphToComposition,
  importHar,
  suggestHarVariables,
  validateHar,
} from "@k6flow/shared";
import type {
  Har,
  HarResourceType,
  HarVariableSuggestion,
} from "@k6flow/shared";
import { MainLayout } from "../../lib/layout";
import { scenarioEditorHref } from "../../lib/editor/editor-route-params";
import {
  availableMethods,
  filterPreviewEntries,
  harEntries,
  pruneHar,
  summarize,
} from "../../lib/import/har-preview";
import type { PreviewEntry, PreviewFilters } from "../../lib/import/har-preview";

/** Grouping gap the importer uses when the user leaves the field empty. */
const DEFAULT_STEP_GAP_MS = 2000;
/** Name handed to the importer for the client-side preview; never persisted. */
const PREVIEW_NAME = "preview";
const MAX_WARNINGS_SHOWN = 8;

interface FilterState {
  /** Empty means "every type"; the page keeps at least one type active. */
  resourceTypes: HarResourceType[];
  /** Empty means "every method present in the file". */
  methods: string[];
  statusMin: string;
  statusMax: string;
  includeDomains: string;
  excludeDomains: string;
  text: string;
}

const EMPTY_FILTERS: FilterState = {
  resourceTypes: [],
  methods: [],
  statusMin: "",
  statusMax: "",
  includeDomains: "",
  excludeDomains: "",
  text: "",
};

interface ImportResponse {
  id: string;
  name: string;
  stats: {
    totalEntries: number;
    importedEntries: number;
    skippedEntries: number;
    steps: number;
  };
  warnings: string[];
  variableSuggestions: HarVariableSuggestion[];
}

interface ImportedScenario {
  id: string;
  name: string;
  stats: ImportResponse["stats"];
  warnings: string[];
}

interface PreviewState {
  suggestions: HarVariableSuggestion[];
  warnings: string[];
  steps: number;
  error: string | null;
}

/** Request body filters of `POST /api/import/har`, as the route parses them. */
interface ImportOptionsBody {
  excludeStatic: boolean;
  mainDocumentsOnly: boolean;
  stepGapMs: number;
  useHarTimings: boolean;
  includeResourceTypes?: HarResourceType[];
  methods?: string[];
  statusMin?: number;
  statusMax?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

// -----------------------------------------------------------------------------
// Parsing the form fields
// -----------------------------------------------------------------------------

/** Number from a text field; blank or non-numeric text means "no bound". */
function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Comma, semicolon or whitespace separated domain list. */
function domainList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
}

function resourceTypeList(values: readonly HarResourceType[]): HarResourceType[] {
  return values.length === 0 ? [...HAR_RESOURCE_TYPES] : [...values];
}

function statusTone(status: number): string {
  if (status >= 400) return "badge-error";
  if (status >= 300) return "badge-warning";
  return "badge-success";
}

const toggleIn = <T,>(values: readonly T[], value: T): T[] =>
  values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];

export default function ImportHarPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [har, setHar] = useState<Har | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [scenarioName, setScenarioName] = useState("");
  const [stepGapMs, setStepGapMs] = useState(String(DEFAULT_STEP_GAP_MS));
  const [useHarTimings, setUseHarTimings] = useState(true);
  const [applySuggestedVariables, setApplySuggestedVariables] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportedScenario | null>(null);

  // --- Reading the file -------------------------------------------------------

  const loadFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setFileError(null);
    setSubmitError(null);
    setResult(null);
    // A new file replaces the previous one, including its selection, so a stale
    // HAR can never be submitted while an error for the new one is showing.
    setHar(null);
    setFileName(null);
    setSelection(new Set());

    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileError("No se pudo leer el archivo. Intenta exportarlo de nuevo.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setFileError(
        "El archivo no es JSON válido. Exporta el HAR desde la pestaña Red de las DevTools (Export HAR...).",
      );
      return;
    }

    if (!validateHar(parsed)) {
      setFileError("El archivo no tiene formato HAR: falta log.entries con las peticiones.");
      return;
    }

    const rows = harEntries(parsed);
    if (rows.length === 0) {
      setFileError("El HAR no contiene peticiones para importar.");
      return;
    }

    setHar(parsed);
    setFileName(file.name);
    setFilters(EMPTY_FILTERS);
    setSelection(new Set(rows.map((row) => row.index)));
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Allow re-picking the same file after fixing it.
    event.target.value = "";
    void loadFile(file);
  };

  // --- Derived preview -------------------------------------------------------

  const rows = useMemo<PreviewEntry[]>(() => (har === null ? [] : harEntries(har)), [har]);

  const methodOptions = useMemo(() => availableMethods(rows), [rows]);

  // An empty list means "everything", so the toggles treat all values as active
  // and unchecking one narrows the allow-list. Unchecking the last one restores
  // "everything" instead of hiding the whole table.
  const activeResourceTypes = useMemo<HarResourceType[]>(
    () => resourceTypeList(filters.resourceTypes),
    [filters.resourceTypes],
  );
  const activeMethods = useMemo<string[]>(
    () => (filters.methods.length === 0 ? methodOptions : filters.methods),
    [filters.methods, methodOptions],
  );

  const previewFilters = useMemo<PreviewFilters>(
    () => ({
      resourceTypes: activeResourceTypes,
      methods: activeMethods,
      statusMin: optionalNumber(filters.statusMin),
      statusMax: optionalNumber(filters.statusMax),
      includeDomains: domainList(filters.includeDomains),
      excludeDomains: domainList(filters.excludeDomains),
      text: filters.text,
    }),
    // `activeResourceTypes` and `activeMethods` are memoised from these inputs.
    [filters, activeResourceTypes, activeMethods],
  );

  const visible = useMemo(() => filterPreviewEntries(rows, previewFilters), [rows, previewFilters]);

  /** Original indexes of the requests that would be uploaded, in file order. */
  const keepIndexes = useMemo<ReadonlySet<number>>(
    () => new Set(visible.filter((entry) => selection.has(entry.index)).map((entry) => entry.index)),
    [visible, selection],
  );

  const summary = useMemo(() => summarize(rows, keepIndexes), [rows, keepIndexes]);

  const parsedStepGapMs = optionalNumber(stepGapMs);
  const effectiveStepGapMs = parsedStepGapMs !== undefined && parsedStepGapMs >= 0
    ? parsedStepGapMs
    : DEFAULT_STEP_GAP_MS;

  /**
   * Options sent to `/api/import/har`, and the same object the client-side
   * preview runs with, so the panel cannot drift from what the server stores.
   * Only the filters that actually narrow the file are sent: the HAR is already
   * pruned, so every one of them is inert by construction.
   */
  const importOptions = useMemo<ImportOptionsBody>(() => {
    const includedDomains = domainList(filters.includeDomains);
    const excludedDomains = domainList(filters.excludeDomains);
    const narrowedTypes = activeResourceTypes.length === HAR_RESOURCE_TYPES.length
      ? undefined
      : activeResourceTypes;
    const narrowedMethods = activeMethods.length === methodOptions.length
      ? undefined
      : activeMethods;

    return {
      excludeStatic: false,
      mainDocumentsOnly: false,
      stepGapMs: effectiveStepGapMs,
      useHarTimings,
      ...(narrowedTypes === undefined ? {} : { includeResourceTypes: narrowedTypes }),
      ...(narrowedMethods === undefined ? {} : { methods: narrowedMethods }),
      ...(previewFilters.statusMin === undefined ? {} : { statusMin: previewFilters.statusMin }),
      ...(previewFilters.statusMax === undefined ? {} : { statusMax: previewFilters.statusMax }),
      ...(includedDomains.length === 0 ? {} : { includeDomains: includedDomains }),
      ...(excludedDomains.length === 0 ? {} : { excludeDomains: excludedDomains }),
    };
  }, [effectiveStepGapMs, useHarTimings, previewFilters, activeResourceTypes, activeMethods, methodOptions, filters.includeDomains, filters.excludeDomains]);

  // The same pipeline the route runs, on the pruned HAR (D8), so the panel shows
  // exactly the suggestions the import would produce.
  const preview = useMemo<PreviewState>(() => {
    if (har === null || keepIndexes.size === 0) {
      return { suggestions: [], warnings: [], steps: 0, error: null };
    }
    try {
      const imported = importHar(pruneHar(har, keepIndexes), { name: PREVIEW_NAME, ...importOptions });
      const bridged = harGraphToComposition(imported.graph);
      return {
        suggestions: suggestHarVariables(imported.graph, bridged.composition),
        warnings: [...imported.warnings, ...bridged.warnings],
        steps: imported.stats.steps,
        error: null,
      };
    } catch {
      // A malformed URL inside the file would otherwise break the render.
      return {
        suggestions: [],
        warnings: [],
        steps: 0,
        error: "No se pudieron analizar estas peticiones. Revisa el archivo HAR.",
      };
    }
  }, [har, keepIndexes, importOptions]);

  // --- Selection actions -----------------------------------------------------

  const toggleEntry = (index: number): void => {
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectVisible = (): void => {
    setSelection((previous) => {
      const next = new Set(previous);
      for (const entry of visible) next.add(entry.index);
      return next;
    });
  };

  const deselectVisible = (): void => {
    setSelection((previous) => {
      const next = new Set(previous);
      for (const entry of visible) next.delete(entry.index);
      return next;
    });
  };

  // --- Submitting ------------------------------------------------------------

  const canSubmit = har !== null
    && keepIndexes.size > 0
    && scenarioName.trim().length > 0
    && !isSubmitting;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || har === null) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setResult(null);

    try {
      const response = await fetch("/api/import/har", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName.trim(),
          har: pruneHar(har, keepIndexes),
          applySuggestedVariables,
          options: importOptions,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | (Partial<ImportResponse> & { error?: string })
        | null;

      if (!response.ok) {
        setSubmitError(payload?.error ?? `No se pudo importar el HAR (HTTP ${response.status}).`);
        return;
      }

      if (payload?.id === undefined || payload.stats === undefined) {
        setSubmitError("La respuesta del servidor no trajo el escenario creado.");
        return;
      }

      setResult({
        id: payload.id,
        name: payload.name ?? scenarioName.trim(),
        stats: payload.stats,
        warnings: payload.warnings ?? [],
      });
      setScenarioName("");
    } catch {
      setSubmitError("No se pudo contactar con el servidor de importación.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Render ----------------------------------------------------------------

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        <section className="flex flex-col gap-space-xs">
          <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
            <span className="material-symbols-outlined text-secondary text-[16px]">upload_file</span>
            <span>Importar tráfico</span>
          </div>
          <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
            Importar HAR
          </h1>
          <p className="text-body-md text-on-surface-variant">
            Sube un archivo <span className="font-mono">.har</span> exportado del navegador, filtra
            las peticiones como en las DevTools y guarda solo las que necesites en el escenario.
          </p>
        </section>

        <section className="card">
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Archivo HAR
          </label>
          <input
            type="file"
            accept=".har,.json,application/json"
            onChange={handleFileChange}
            className="input"
          />
          {fileName !== null && har !== null && (
            <p className="mt-space-sm text-body-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-[16px] align-middle mr-space-xs">
                description
              </span>
              {fileName} — {summary.total} peticiones detectadas
            </p>
          )}
          {fileError !== null && (
            <div className="mt-space-md p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm">
              <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle">
                error
              </span>
              {fileError}
            </div>
          )}
        </section>

        {har !== null && (
          <>
            <section className="card flex flex-col gap-space-md">
              <div className="flex items-center justify-between gap-space-md">
                <h2 className="text-headline-sm text-on-surface font-medium">Filtros</h2>
                <button
                  type="button"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="btn-secondary"
                >
                  <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
                  <span>Limpiar filtros</span>
                </button>
              </div>

              <div className="flex flex-col gap-space-xs">
                <span className="text-body-sm text-on-surface-variant">Tipo de petición</span>
                <div className="flex flex-wrap gap-space-xs">
                  {HAR_RESOURCE_TYPES.map((resourceType) => {
                    const active = activeResourceTypes.includes(resourceType);
                    return (
                      <button
                        key={resourceType}
                        type="button"
                        onClick={() =>
                          setFilters((previous) => ({
                            ...previous,
                            resourceTypes: toggleIn(
                              resourceTypeList(previous.resourceTypes),
                              resourceType,
                            ),
                          }))
                        }
                        className={`px-space-md py-1 rounded-lg text-body-sm font-mono transition-all ${
                          active
                            ? "bg-surface-container-high text-on-surface shadow-sm"
                            : "bg-surface-container-lowest text-on-surface-variant"
                        }`}
                      >
                        {resourceType}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-space-xs">
                <span className="text-body-sm text-on-surface-variant">Método</span>
                <div className="flex flex-wrap gap-space-xs">
                  {methodOptions.map((method) => {
                    const active = activeMethods.includes(method);
                    return (
                      <button
                        key={method}
                        type="button"
                        onClick={() =>
                          setFilters((previous) => ({
                            ...previous,
                            methods: toggleIn(
                              previous.methods.length === 0 ? methodOptions : previous.methods,
                              method,
                            ),
                          }))
                        }
                        className={`px-space-md py-1 rounded-lg text-body-sm font-mono transition-all ${
                          active
                            ? "bg-surface-container-high text-on-surface shadow-sm"
                            : "bg-surface-container-lowest text-on-surface-variant"
                        }`}
                      >
                        {method}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                <div>
                  <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                    Estado mínimo
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={filters.statusMin}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, statusMin: event.target.value }))
                    }
                    placeholder="200"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                    Estado máximo
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={filters.statusMax}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, statusMax: event.target.value }))
                    }
                    placeholder="299"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                    Incluir dominios
                  </label>
                  <input
                    type="text"
                    value={filters.includeDomains}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, includeDomains: event.target.value }))
                    }
                    placeholder="api.example.com, example.com"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                    Excluir dominios
                  </label>
                  <input
                    type="text"
                    value={filters.excludeDomains}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, excludeDomains: event.target.value }))
                    }
                    placeholder="google-analytics.com, sentry.io"
                    className="input"
                  />
                </div>
              </div>

              <div>
                <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                  Buscar en método o URL
                </label>
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-space-md text-[18px] text-on-surface-variant">
                    search
                  </span>
                  <input
                    type="text"
                    value={filters.text}
                    onChange={(event) =>
                      setFilters((previous) => ({ ...previous, text: event.target.value }))
                    }
                    placeholder="/api/v1/items"
                    className="input pl-10"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-space-md text-body-sm text-on-surface-variant">
                <span>
                  <span className="badge-success">{summary.kept} seleccionadas</span>
                </span>
                <span>
                  <span className="badge-warning">{summary.dropped} fuera</span>
                </span>
                <span className="font-mono">{visible.length} visibles</span>
                <span className="text-label-code-sm text-on-surface-variant">
                  Solo se importan las peticiones visibles que estén marcadas.
                </span>
                <div className="flex items-center gap-space-xs ml-auto">
                  <button type="button" onClick={selectVisible} className="btn-secondary">
                    <span className="material-symbols-outlined text-[16px]">check_box</span>
                    <span>Marcar visibles</span>
                  </button>
                  <button type="button" onClick={deselectVisible} className="btn-secondary">
                    <span className="material-symbols-outlined text-[16px]">
                      check_box_outline_blank
                    </span>
                    <span>Desmarcar visibles</span>
                  </button>
                </div>
              </div>
            </section>

            <section className="card p-0 overflow-hidden">
              {visible.length === 0 ? (
                <div className="text-center py-space-xl">
                  <span className="material-symbols-outlined text-on-surface-variant text-[40px] mb-space-md">
                    filter_alt_off
                  </span>
                  <p className="text-body-md text-on-surface-variant">
                    Ninguna petición coincide con los filtros.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-surface-container-low">
                      <tr className="text-left text-label-code-sm text-on-surface-variant uppercase">
                        <th className="table-cell w-12 text-center">Incluir</th>
                        <th className="table-cell w-20">Método</th>
                        <th className="table-cell">Petición</th>
                        <th className="table-cell w-24">Tipo</th>
                        <th className="table-cell w-20">Estado</th>
                        <th className="table-cell w-24">Duración</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((entry) => (
                        <tr key={entry.index} className="table-row">
                          <td className="table-cell text-center">
                            <input
                              type="checkbox"
                              checked={selection.has(entry.index)}
                              onChange={() => toggleEntry(entry.index)}
                              aria-label={`Incluir ${entry.method} ${entry.url}`}
                            />
                          </td>
                          <td className="table-cell font-mono text-on-surface">{entry.method}</td>
                          <td className="table-cell">
                            <span className="font-mono text-on-surface-variant">{entry.origin}</span>
                            <span className="font-mono text-on-surface">{entry.path}</span>
                          </td>
                          <td className="table-cell font-mono text-on-surface-variant">
                            {entry.resourceType}
                          </td>
                          <td className="table-cell">
                            <span className={statusTone(entry.status)}>{entry.status}</span>
                          </td>
                          <td className="table-cell font-mono text-on-surface-variant">
                            {Math.round(entry.durationMs)} ms
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-lg items-start">
              <section
                className="card flex flex-col gap-space-md"
                aria-labelledby="suggested-variables"
              >
                <div className="flex items-center justify-between gap-space-md">
                  <h2
                    id="suggested-variables"
                    className="text-headline-sm text-on-surface font-medium"
                  >
                    Variables sugeridas
                  </h2>
                  <span className="badge-success">{preview.suggestions.length}</span>
                </div>
                <p className="text-body-sm text-on-surface-variant">
                  Valores repartidos por todas las peticiones que conviene convertir en variables
                  para reutilizar el escenario en otros entornos.
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
                        <li
                          key={`${position}-${warning}`}
                          className="text-label-code-sm text-on-surface-variant"
                        >
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              <form onSubmit={submit} className="card flex flex-col gap-space-md">
                <h2 className="text-headline-sm text-on-surface font-medium">Guardar escenario</h2>

                <div>
                  <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                    Nombre del escenario
                  </label>
                  <input
                    type="text"
                    value={scenarioName}
                    onChange={(event) => setScenarioName(event.target.value)}
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
                      onChange={(event) => setStepGapMs(event.target.value)}
                      className="input"
                    />
                  </div>
                  <label className="flex items-center gap-space-sm text-body-sm text-on-surface-variant">
                    <input
                      type="checkbox"
                      checked={useHarTimings}
                      onChange={(event) => setUseHarTimings(event.target.checked)}
                    />
                    Respetar los tiempos del HAR
                  </label>
                </div>

                <label className="flex items-start gap-space-sm text-body-sm text-on-surface-variant">
                  <input
                    type="checkbox"
                    checked={applySuggestedVariables}
                    onChange={(event) => setApplySuggestedVariables(event.target.checked)}
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
                    <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle">
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
                      <span className="material-symbols-outlined text-[18px]">save</span>
                      <span>Importar {summary.kept} peticiones</span>
                    </>
                  )}
                </button>

                {keepIndexes.size === 0 && (
                  <p className="text-body-sm text-on-surface-variant">
                    Marca al menos una petición de la tabla para continuar.
                  </p>
                )}
                {scenarioName.trim().length === 0 && (
                  <p className="text-body-sm text-on-surface-variant">
                    El escenario necesita un nombre.
                  </p>
                )}

                {result !== null && (
                  <div className="flex flex-col gap-space-sm p-space-md rounded-lg bg-surface-container-lowest border border-surface-container">
                    <div className="flex items-center gap-space-sm">
                      <span className="material-symbols-outlined text-[18px] text-success">
                        check_circle
                      </span>
                      <span className="text-body-md text-on-surface">
                        Escenario «{result.name}» creado
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-space-md text-body-sm text-on-surface-variant">
                      <span>{result.stats.importedEntries} peticiones importadas</span>
                      <span>{result.stats.steps} pasos</span>
                      <span>{result.stats.skippedEntries} omitidas</span>
                    </div>
                    {result.warnings.length > 0 && (
                      <ul className="flex flex-col gap-space-xs">
                        {result.warnings.map((warning, position) => (
                          <li
                            key={`${position}-${warning}`}
                            className="text-label-code-sm text-on-surface-variant"
                          >
                            {warning}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link href={scenarioEditorHref(result.id)} className="btn-primary justify-center">
                      <span className="material-symbols-outlined text-[18px]">account_tree</span>
                      <span>Abrir en el editor</span>
                    </Link>
                  </div>
                )}
              </form>
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}
