/**
 * Model shared by the HAR import screen and its pieces (T8b/D7/D8/D9).
 *
 * `page.tsx` owns the state and the request; the components in this folder only
 * receive values and callbacks, so the shapes they exchange live here instead of
 * inside one of them.
 */

import type { HarResourceType, HarVariableSuggestion } from "@k6flow/shared";

/** DevTools-style filters as the form fields hold them, before parsing. */
export interface FilterState {
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

/** Cleared filters: what the form starts with and what "Limpiar filtros" restores. */
export const EMPTY_FILTERS: FilterState = {
  resourceTypes: [],
  methods: [],
  statusMin: "",
  statusMax: "",
  includeDomains: "",
  excludeDomains: "",
  text: "",
};

/** Successful body of `POST /api/import/har`. */
export interface ImportResponse {
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

/** The created scenario, as the result card shows it. */
export interface ImportedScenario {
  id: string;
  name: string;
  stats: ImportResponse["stats"];
  warnings: string[];
}

/** Client-side preview of the pruned HAR, from the same pipeline as the route. */
export interface PreviewState {
  suggestions: HarVariableSuggestion[];
  warnings: string[];
  steps: number;
  error: string | null;
}

/** Request body filters of `POST /api/import/har`, as the route parses them. */
export interface ImportOptionsBody {
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
