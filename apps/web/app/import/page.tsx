"use client";

/**
 * HAR import screen (T8b/D7/D8/D9). Orchestrator only: state, file reading and
 * validation, the memoised preview, the submit and the layout of the pieces in
 * `./components`. `lib/import/har-preview.ts` keeps the filtering/pruning.
 *
 * The file never leaves the browser until the user confirms: the page reads the
 * `.har`, classifies and filters it with the shared modules, prunes it to the
 * checked requests and only then posts the reduced HAR to `/api/import/har`.
 * Filtering, selection and the preview are memoised so typing in a filter
 * recomputes the table and nothing else; only the confirm button requests.
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Har, HarResourceType } from "@k6flow/shared";
import { MainLayout } from "../../lib/layout";
import {
  availableMethods,
  filterPreviewEntries,
  harEntries,
  pruneHar,
  summarize,
} from "../../lib/import/har-preview";
import type { PreviewEntry } from "../../lib/import/har-preview";
import { HarFileUploader } from "./components/HarFileUploader";
import { HarFiltersPanel } from "./components/HarFiltersPanel";
import { HarImportHeader } from "./components/HarImportHeader";
import { HarRequestsTable } from "./components/HarRequestsTable";
import { HarSaveScenarioForm } from "./components/HarSaveScenarioForm";
import { HarVariableSuggestionsPanel } from "./components/HarVariableSuggestionsPanel";
import {
  addIndexes,
  effectiveStepGapMs,
  removeIndexes,
  resourceTypeList,
  toggleIndex,
} from "./components/helpers";
import { postHarImport, readHarFile } from "./components/har-import-io";
import {
  EMPTY_PREVIEW,
  buildImportOptions,
  buildPreviewFilters,
  previewHar,
} from "./components/preview";
import {
  EMPTY_FILTERS,
  type FilterState,
  type ImportedScenario,
  type PreviewState,
} from "./components/types";

/** Grouping gap the importer uses when the user leaves the field empty. */
const DEFAULT_STEP_GAP_MS = 2000;

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

    const outcome = await readHarFile(file);
    if (!outcome.ok) {
      setFileError(outcome.error);
      return;
    }

    setHar(outcome.har);
    setFileName(file.name);
    setFilters(EMPTY_FILTERS);
    setSelection(new Set(outcome.indexes));
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

  const previewFilters = useMemo(
    () => buildPreviewFilters(filters, activeResourceTypes, activeMethods),
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

  const stepGapForImport = effectiveStepGapMs(stepGapMs, DEFAULT_STEP_GAP_MS);

  const importOptions = useMemo(
    () => buildImportOptions({
      filters,
      activeResourceTypes,
      activeMethods,
      methodOptions,
      stepGapMs: stepGapForImport,
      useHarTimings,
    }),
    [filters, activeResourceTypes, activeMethods, methodOptions, stepGapForImport, useHarTimings],
  );

  const preview = useMemo<PreviewState>(
    () => (har === null ? EMPTY_PREVIEW : previewHar(har, keepIndexes, importOptions)),
    [har, keepIndexes, importOptions],
  );

  // --- Selection actions and submit ------------------------------------------

  const toggleEntry = (index: number): void =>
    setSelection((previous) => toggleIndex(previous, index));

  const selectVisible = (): void =>
    setSelection((previous) => addIndexes(previous, visible.map((entry) => entry.index)));

  const deselectVisible = (): void =>
    setSelection((previous) => removeIndexes(previous, visible.map((entry) => entry.index)));

  const canSubmit = har !== null && keepIndexes.size > 0
    && scenarioName.trim().length > 0 && !isSubmitting;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || har === null) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setResult(null);

    try {
      const outcome = await postHarImport({
        name: scenarioName.trim(),
        har: pruneHar(har, keepIndexes),
        applySuggestedVariables,
        options: importOptions,
      });

      if (!outcome.ok) {
        setSubmitError(outcome.error);
        return;
      }

      setResult(outcome.scenario);
      setScenarioName("");
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Render ----------------------------------------------------------------

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        <HarImportHeader />

        <HarFileUploader
          fileName={fileName}
          totalRequests={summary.total}
          fileError={fileError}
          onFile={(file) => void loadFile(file)}
        />

        {har !== null && (
          <>
            <HarFiltersPanel
              filters={filters}
              onFiltersChange={setFilters}
              activeResourceTypes={activeResourceTypes}
              activeMethods={activeMethods}
              methodOptions={methodOptions}
              summary={summary}
              visibleCount={visible.length}
              onSelectVisible={selectVisible}
              onDeselectVisible={deselectVisible}
            />

            <HarRequestsTable entries={visible} selection={selection} onToggle={toggleEntry} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-lg items-start">
              <HarVariableSuggestionsPanel preview={preview} />

              <HarSaveScenarioForm
                scenarioName={scenarioName}
                onScenarioNameChange={setScenarioName}
                stepGapMs={stepGapMs}
                onStepGapMsChange={setStepGapMs}
                useHarTimings={useHarTimings}
                onUseHarTimingsChange={setUseHarTimings}
                applySuggestedVariables={applySuggestedVariables}
                onApplySuggestedVariablesChange={setApplySuggestedVariables}
                preview={preview}
                summary={summary}
                keepCount={keepIndexes.size}
                canSubmit={canSubmit}
                isSubmitting={isSubmitting}
                submitError={submitError}
                result={result}
                onSubmit={submit}
              />
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}
