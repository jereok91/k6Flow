/**
 * HAR preview (T8a/D7/D9): the pure half of the import screen.
 *
 * The import page filters and prunes the HAR in the browser and only uploads the
 * requests the user kept, so the API route needs no change. Everything that can
 * be decided without React lives here:
 * - `harEntries` reads the file into one row per request (D2 classification),
 * - `filterPreviewEntries` applies the DevTools-style filters,
 * - `pruneHar` builds the reduced HAR that is sent to the server,
 * - `summarize` reports what the current selection would import.
 *
 * Row identity is the entry's position in `har.log.entries`, which is also the
 * index `pruneHar` keeps, so selection survives filtering without extra keys.
 */

import { HAR_RESOURCE_TYPES, classifyHarEntry } from "@k6flow/shared";
import type { Har, HarEntry, HarResourceType } from "@k6flow/shared";

/** One request as the table shows it. */
export interface PreviewEntry {
  /** Position in `har.log.entries`; the identity used by selection and pruning. */
  index: number;
  /** Request method, upper-cased so the method toggles compare reliably. */
  method: string;
  /** Full request URL, exactly as the HAR carried it. */
  url: string;
  /** Pathname of `url`, or the raw URL when it cannot be parsed. */
  path: string;
  /** `scheme://host[:port]`, or an empty string when `url` cannot be parsed. */
  origin: string;
  /** Response status code. */
  status: number;
  /** DevTools resource type (D2). */
  resourceType: HarResourceType;
  /** `entry.time` in milliseconds; a non-finite value becomes 0. */
  durationMs: number;
  startedDateTime: string;
}

/**
 * DevTools-style filters. Absent, empty or blank fields mean "no restriction",
 * the kinds combine with AND and the values inside one kind with OR (D1).
 */
export interface PreviewFilters {
  /** Keep only these resource types. */
  resourceTypes?: readonly HarResourceType[];
  /** Keep only these methods (case-insensitive). */
  methods?: readonly string[];
  /** Inclusive lower bound on the response status. */
  statusMin?: number;
  /** Inclusive upper bound on the response status. */
  statusMax?: number;
  /** Keep only requests whose host is one of these domains or a subdomain. */
  includeDomains?: readonly string[];
  /** Drop requests whose host is one of these domains or a subdomain. */
  excludeDomains?: readonly string[];
  /** Case-insensitive substring over "METHOD url". */
  text?: string;
}

/** What the current selection would import. */
export interface PreviewSummary {
  /** Rows in the file. */
  total: number;
  /** Selected rows. */
  kept: number;
  /** Rows the import would leave out. */
  dropped: number;
  /** Kept rows per resource type. */
  byResourceType: Record<string, number>;
  /** Kept rows per HTTP method. */
  byMethod: Record<string, number>;
  /** Distinct origins among the kept rows, in first-appearance order. */
  origins: string[];
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function methodOf(entry: HarEntry): string {
  const method = typeof entry.request?.method === "string" ? entry.request.method : "";
  const trimmed = method.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : "GET";
}

function durationOf(entry: HarEntry): number {
  return Number.isFinite(entry.time) ? entry.time : 0;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toSet<T>(values: readonly T[] | undefined): Set<T> | undefined {
  return values && values.length > 0 ? new Set(values) : undefined;
}

/** Domains are compared lower-cased, without a leading dot or blanks. */
function normalizeDomains(domains?: readonly string[]): string[] | undefined {
  if (!domains || domains.length === 0) return undefined;
  const normalized = domains
    .map((domain) => domain.trim().toLowerCase().replace(/^\./, ""))
    .filter((domain) => domain.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostOfUrl(url: string): string {
  return parseUrl(url)?.hostname.toLowerCase() ?? "";
}

/**
 * Reads every entry of a HAR into a preview row, keeping the original order so a
 * row index always addresses the same entry.
 */
export function harEntries(har: Har): PreviewEntry[] {
  const entries = har.log?.entries ?? [];
  return entries.map((entry, index) => {
    const url = typeof entry.request?.url === "string" ? entry.request.url : "";
    const parsed = parseUrl(url);
    return {
      index,
      method: methodOf(entry),
      url,
      path: parsed === undefined ? url.trim() : parsed.pathname,
      origin: parsed?.origin ?? "",
      status: typeof entry.response?.status === "number" ? entry.response.status : 0,
      resourceType: classifyHarEntry(entry),
      durationMs: durationOf(entry),
      startedDateTime: entry.startedDateTime,
    };
  });
}

/**
 * Applies the DevTools-style filters. The result keeps the input order, and an
 * empty filter object returns the same rows.
 */
export function filterPreviewEntries(
  entries: readonly PreviewEntry[],
  filters: PreviewFilters = {},
): PreviewEntry[] {
  const resourceTypes = toSet(filters.resourceTypes);
  const methods = toSet(filters.methods?.map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0));
  const statusMin = finiteOrUndefined(filters.statusMin);
  const statusMax = finiteOrUndefined(filters.statusMax);
  const includeDomains = normalizeDomains(filters.includeDomains);
  const excludedDomains = normalizeDomains(filters.excludeDomains);
  const text = filters.text?.trim().toLowerCase() ?? "";

  return entries.filter((entry) => {
    if (resourceTypes && !resourceTypes.has(entry.resourceType)) return false;
    if (methods && !methods.has(entry.method)) return false;
    if (statusMin !== undefined && entry.status < statusMin) return false;
    if (statusMax !== undefined && entry.status > statusMax) return false;

    if (includeDomains || excludedDomains) {
      const host = hostOfUrl(entry.url);
      if (includeDomains && !includeDomains.some((domain) => hostMatchesDomain(host, domain))) {
        return false;
      }
      if (host.length > 0
        && excludedDomains?.some((domain) => hostMatchesDomain(host, domain)) === true) {
        return false;
      }
    }

    if (text.length > 0 && !`${entry.method} ${entry.url}`.toLowerCase().includes(text)) {
      return false;
    }

    return true;
  });
}

/**
 * Returns a NEW HAR holding only the entries whose original index is in
 * `keepIndexes`, in the original order. Every other `log` field (`version`,
 * `creator`, `pages`, export-specific keys) and every extra top-level key is
 * copied unchanged, and the input is never mutated.
 */
export function pruneHar(har: Har, keepIndexes: ReadonlySet<number>): Har {
  const entries = har.log?.entries ?? [];
  return {
    ...har,
    log: {
      ...har.log,
      entries: entries.filter((_entry, index) => keepIndexes.has(index)),
    },
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Counts the rows a selection would import. `entries` is the whole file and
 * `selected` the indexes actually going into the scenario, so `dropped` covers
 * both the filtered-out and the unchecked requests.
 */
export function summarize(
  entries: readonly PreviewEntry[],
  selected: ReadonlySet<number>,
): PreviewSummary {
  const kept = entries.filter((entry) => selected.has(entry.index));
  const origins: string[] = [];
  for (const entry of kept) {
    if (entry.origin.length === 0 || origins.includes(entry.origin)) continue;
    origins.push(entry.origin);
  }

  return {
    total: entries.length,
    kept: kept.length,
    dropped: entries.length - kept.length,
    byResourceType: countBy(kept.map((entry) => entry.resourceType)),
    byMethod: countBy(kept.map((entry) => entry.method)),
    origins,
  };
}

/** Resource types present in the file, in the shared vocabulary order. */
export function availableResourceTypes(entries: readonly PreviewEntry[]): HarResourceType[] {
  const present = new Set(entries.map((entry) => entry.resourceType));
  return HAR_RESOURCE_TYPES.filter((resourceType) => present.has(resourceType));
}

/** Methods present in the file, once each, in first-appearance order. */
export function availableMethods(entries: readonly PreviewEntry[]): string[] {
  const methods: string[] = [];
  for (const entry of entries) {
    if (!methods.includes(entry.method)) methods.push(entry.method);
  }
  return methods;
}
