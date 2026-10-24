/**
 * Pure helpers of the HAR import screen: form parsing, badge tones and the
 * selection arithmetic the page and its pieces share.
 *
 * None of them decides what is filtered or pruned — `lib/import/har-preview.ts`
 * stays the single place for that — they only turn form text into values and
 * toggle immutable state.
 */

import { HAR_RESOURCE_TYPES } from "@k6flow/shared";
import type { HarResourceType } from "@k6flow/shared";

/** Number from a text field; blank or non-numeric text means "no bound". */
export function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Comma, semicolon or whitespace separated domain list. */
export function domainList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
}

/** An empty type list means "everything", so it expands to the whole vocabulary. */
export function resourceTypeList(values: readonly HarResourceType[]): HarResourceType[] {
  return values.length === 0 ? [...HAR_RESOURCE_TYPES] : [...values];
}

/**
 * Step gap to import with: the parsed field when it is a non-negative number,
 * otherwise the importer's default.
 */
export function effectiveStepGapMs(text: string, fallback: number): number {
  const parsed = optionalNumber(text);
  return parsed !== undefined && parsed >= 0 ? parsed : fallback;
}

/** Badge class of a response status, as the table colours it. */
export function statusTone(status: number): string {
  if (status >= 400) return "badge-error";
  if (status >= 300) return "badge-warning";
  return "badge-success";
}

/** Adds `value` when absent, removes it when present, without mutating `values`. */
export function toggleIn<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

/** Adds or removes one row index from the selection. */
export function toggleIndex(
  selection: ReadonlySet<number>,
  index: number,
): ReadonlySet<number> {
  const next = new Set(selection);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** Adds every row index to the selection. */
export function addIndexes(
  selection: ReadonlySet<number>,
  indexes: Iterable<number>,
): ReadonlySet<number> {
  const next = new Set(selection);
  for (const index of indexes) next.add(index);
  return next;
}

/** Removes every row index from the selection. */
export function removeIndexes(
  selection: ReadonlySet<number>,
  indexes: Iterable<number>,
): ReadonlySet<number> {
  const next = new Set(selection);
  for (const index of indexes) next.delete(index);
  return next;
}
