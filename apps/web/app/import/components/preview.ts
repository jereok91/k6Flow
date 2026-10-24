/**
 * Pure pipeline of the HAR import screen, the same one the route runs: the
 * options derived from the form and the client-side preview of the pruned HAR.
 *
 * `lib/import/har-preview.ts` still owns the filtering and pruning; this module
 * only wires those calls together so `page.tsx` can memoise the result.
 */

import { harGraphToComposition, importHar, suggestHarVariables } from "@k6flow/shared";
import type { Har, HarResourceType } from "@k6flow/shared";
import { HAR_RESOURCE_TYPES } from "@k6flow/shared";
import { pruneHar } from "../../../lib/import/har-preview";
import type { PreviewFilters } from "../../../lib/import/har-preview";
import { domainList, optionalNumber } from "./helpers";
import type { FilterState, ImportOptionsBody, PreviewState } from "./types";

/** Name handed to the importer for the client-side preview; never persisted. */
const PREVIEW_NAME = "preview";

/** Nothing to preview yet: no file, or no row selected. */
export const EMPTY_PREVIEW: PreviewState = {
  suggestions: [],
  warnings: [],
  steps: 0,
  error: null,
};

/** Everything `buildImportOptions` reads from the page. */
export interface ImportOptionsInput {
  filters: FilterState;
  activeResourceTypes: readonly HarResourceType[];
  activeMethods: readonly string[];
  methodOptions: readonly string[];
  stepGapMs: number;
  useHarTimings: boolean;
}

/**
 * Filters of `lib/import/har-preview.ts`, built from the form text and the
 * already-expanded type and method lists.
 */
export function buildPreviewFilters(
  filters: FilterState,
  activeResourceTypes: readonly HarResourceType[],
  activeMethods: readonly string[],
): PreviewFilters {
  return {
    resourceTypes: activeResourceTypes,
    methods: activeMethods,
    statusMin: optionalNumber(filters.statusMin),
    statusMax: optionalNumber(filters.statusMax),
    includeDomains: domainList(filters.includeDomains),
    excludeDomains: domainList(filters.excludeDomains),
    text: filters.text,
  };
}

/**
 * Options sent to `/api/import/har`, and the same object the preview runs with,
 * so the panel cannot drift from what the server stores. Only the filters that
 * actually narrow the file are sent: the HAR is already pruned, so every one of
 * them is inert by construction.
 */
export function buildImportOptions(input: ImportOptionsInput): ImportOptionsBody {
  const includedDomains = domainList(input.filters.includeDomains);
  const excludedDomains = domainList(input.filters.excludeDomains);
  const narrowedTypes = input.activeResourceTypes.length === HAR_RESOURCE_TYPES.length
    ? undefined
    : [...input.activeResourceTypes];
  const narrowedMethods = input.activeMethods.length === input.methodOptions.length
    ? undefined
    : [...input.activeMethods];
  const statusMin = optionalNumber(input.filters.statusMin);
  const statusMax = optionalNumber(input.filters.statusMax);

  return {
    excludeStatic: false,
    mainDocumentsOnly: false,
    stepGapMs: input.stepGapMs,
    useHarTimings: input.useHarTimings,
    ...(narrowedTypes === undefined ? {} : { includeResourceTypes: narrowedTypes }),
    ...(narrowedMethods === undefined ? {} : { methods: narrowedMethods }),
    ...(statusMin === undefined ? {} : { statusMin }),
    ...(statusMax === undefined ? {} : { statusMax }),
    ...(includedDomains.length === 0 ? {} : { includeDomains: includedDomains }),
    ...(excludedDomains.length === 0 ? {} : { excludeDomains: excludedDomains }),
  };
}

/**
 * Preview of `har` pruned to `keepIndexes`, produced by the same pipeline the
 * route runs (D8), so the panel shows exactly what the import would produce.
 */
export function previewHar(
  har: Har,
  keepIndexes: ReadonlySet<number>,
  options: ImportOptionsBody,
): PreviewState {
  if (keepIndexes.size === 0) return EMPTY_PREVIEW;
  try {
    const imported = importHar(pruneHar(har, keepIndexes), { name: PREVIEW_NAME, ...options });
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
}
