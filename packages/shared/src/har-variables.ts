/**
 * HAR variable suggestions (S4/D4): the importer suggests, it never imposes.
 *
 * `importHar` keeps every value it found, so the graph still holds hardcoded
 * hosts and credentials. This module detects the values worth turning into
 * `{{name}}` placeholders, tells the caller why each one was proposed and
 * whether it is a secret, and rewrites a composition only when the caller
 * passes the suggestions back to `applyVariableSuggestions`.
 *
 * Detection runs on the imported graph (the HAR data), because that is where the
 * headers and query strings live. The optional composition is used to count
 * `occurrences` against what the rewrite would actually touch.
 *
 * A suggestion is only produced when one variable can really stand for the
 * value. Values that change per request are deliberately not suggested; the
 * list below records every such case for the caller:
 * - Authorization: values that never repeat are per-request tokens, so no
 *   variable is invented for them.
 * - Cookie, api key header and query parameter: a name whose value differs
 *   between requests cannot be one variable, so it is skipped.
 */

import type { GraphDraftComposition } from "./graph-composition";
import type { HttpBody, HttpNamedValue, HttpParameters } from "./http-parameters";
import type { HarImportedGraph } from "./har-import";
import type { StringParameterValue } from "./parameter-values";
import { isValidVariableName } from "./variables";

/** Imported nodes tag requests with this type; composition nodes use `http-request`. */
const REQUEST_TYPE = "http_request";

/** Longest name `VARIABLE_NAME_PATTERN` accepts, so a suggestion never overshoots it. */
const MAX_NAME_LENGTH = 64;

const COOKIE_PREFIX = "cookie_";
const HOST_SINGLE_NAME = "baseUrl";
const AUTHORIZATION_NAME = "authToken";

/** Headers that carry an API key or an equivalent static token. */
const API_KEY_HEADERS = ["x-api-key", "apikey", "x-auth-token"] as const;

/** Query parameter names that usually carry a credential. */
const SECRET_QUERY_NAME = /token|key|secret|sig|password|auth/i;

/** Shorter values are too likely to be an id, a flag or a page number. */
const MIN_SECRET_QUERY_VALUE_LENGTH = 8;

export const HAR_VARIABLE_KINDS = [
  "host",
  "authorization",
  "cookie",
  "api-key",
  "query",
] as const;

/** Where the detected value lives in the request. */
export type HarVariableKind = (typeof HAR_VARIABLE_KINDS)[number];

/**
 * Stable, English reason for a suggestion. A UI translates it; the importer
 * never emits localised text.
 */
export const HAR_VARIABLE_REASON_CODES = [
  "single-origin",
  "repeated-origin",
  "shared-authorization",
  "single-authorization",
  "cookie-value",
  "api-key-header",
  "secret-query-param",
] as const;

export type HarVariableReasonCode = (typeof HAR_VARIABLE_REASON_CODES)[number];

export interface HarVariableSuggestion {
  /** Valid variable name, unique across the returned list. */
  name: string;
  /** Concrete value found in the HAR; `{{name}}` replaces it. */
  value: string;
  /** True when the value must not be written into the graph as plain text. */
  secret: boolean;
  kind: HarVariableKind;
  /** Requests (or composition nodes) where the value appears. */
  occurrences: number;
  reasonCode: HarVariableReasonCode;
  detail: string;
}

// -----------------------------------------------------------------------------
// Reading the imported graph
// -----------------------------------------------------------------------------

interface ImportedRequest {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
}

function importedHeaders(node: HarImportedGraph["nodes"][string]): ImportedRequest["headers"] {
  const imported = node.parameters?.headers;
  if (!Array.isArray(imported)) return [];
  const headers: ImportedRequest["headers"] = [];
  for (const header of imported) {
    if (typeof header?.key !== "string" || typeof header.value !== "string") continue;
    const name = header.key.trim().toLowerCase();
    if (name.length === 0) continue;
    headers.push({ name, value: header.value });
  }
  return headers;
}

function importedRequests(graph: HarImportedGraph): ImportedRequest[] {
  const requests: ImportedRequest[] = [];
  // A record keeps insertion order, which is the order the importer wrote.
  for (const node of Object.values(graph.nodes ?? {})) {
    if (node?.type !== REQUEST_TYPE) continue;
    const request: ImportedRequest = {
      url: typeof node.parameters?.url === "string" ? node.parameters.url : "",
      headers: importedHeaders(node),
    };
    if (typeof node.parameters?.body === "string") request.body = node.parameters.body;
    requests.push(request);
  }
  return requests;
}

function headerValue(request: ImportedRequest, name: string): string | undefined {
  return request.headers.find((header) => header.name === name)?.value;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function queryPairs(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

interface CookiePair {
  name: string;
  value: string;
}

/** Splits a `Cookie` header into pairs, dropping blank and valueless entries. */
function parseCookieHeader(header: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name.length === 0 || value.length === 0) continue;
    pairs.push({ name, value });
  }
  return pairs;
}

// -----------------------------------------------------------------------------
// Occurrences: how many requests carry the value
// -----------------------------------------------------------------------------

type OccurrenceCounter = (value: string) => number;

function graphOccurrences(requests: readonly ImportedRequest[]): OccurrenceCounter {
  return (value) => requests.filter((request) =>
    request.url.includes(value)
    || (request.body ?? "").includes(value)
    || request.headers.some((header) => header.value.includes(value))).length;
}

function literalText(value: StringParameterValue): string | undefined {
  return value.kind === "literal" ? value.value : undefined;
}

function httpNodeTexts(parameters: HttpParameters): string[] {
  const texts: string[] = [];
  const push = (text: string | undefined) => {
    if (text !== undefined) texts.push(text);
  };
  push(literalText(parameters.url));
  for (const header of parameters.headers ?? []) push(literalText(header.value));
  for (const entry of parameters.query ?? []) push(literalText(entry.value));
  const body = parameters.body;
  if (body !== undefined && body.kind !== "none") push(literalText(body.value));
  return texts;
}

function compositionOccurrences(composition: GraphDraftComposition): OccurrenceCounter {
  const nodesTexts = composition.nodes.map((node) =>
    node.kind === "http-request" && node.parameters !== undefined
      ? httpNodeTexts(node.parameters)
      : []);
  return (value) => nodesTexts.filter((texts) =>
    texts.some((text) => text.includes(value))).length;
}

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

/** Keeps the characters a variable name allows and makes the first one legal. */
function sanitizedSegment(raw: string): string {
  const collapsed = raw.trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(collapsed) ? collapsed : `_${collapsed}`;
}

/** Bounded, not-yet-used name; collisions get a numeric suffix. */
function uniqueName(base: string, taken: Set<string>): string {
  const bounded = base.slice(0, MAX_NAME_LENGTH);
  if (!taken.has(bounded)) {
    taken.add(bounded);
    return bounded;
  }
  for (let suffix = 2; ; suffix += 1) {
    const text = String(suffix);
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - text.length)}${text}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

// -----------------------------------------------------------------------------
// Detection rules
// -----------------------------------------------------------------------------

interface ValueGroup {
  value: string;
  count: number;
}

/** Groups values per key, keeping the first appearance order of both. */
function addGrouped(groups: Map<string, ValueGroup[]>, key: string, value: string): void {
  const values = groups.get(key) ?? [];
  const existing = values.find((entry) => entry.value === value);
  if (existing === undefined) values.push({ value, count: 1 });
  else existing.count += 1;
  groups.set(key, values);
}

const times = (count: number): string =>
  count === 1 ? "1 imported request" : `${count} imported requests`;

// Rule 1: one variable per distinct origin, named baseUrl or baseUrl1..N.
function hostSuggestions(
  requests: readonly ImportedRequest[],
  occurrencesOf: OccurrenceCounter,
  taken: Set<string>,
): HarVariableSuggestion[] {
  const origins: ValueGroup[] = [];
  for (const request of requests) {
    const origin = originOf(request.url);
    if (origin === undefined) continue;
    const existing = origins.find((entry) => entry.value === origin);
    if (existing === undefined) origins.push({ value: origin, count: 1 });
    else existing.count += 1;
  }
  if (origins.length === 0) return [];

  const single = origins.length === 1;
  return origins.map((entry, index) => ({
    name: uniqueName(single ? HOST_SINGLE_NAME : `${HOST_SINGLE_NAME}${index + 1}`, taken),
    value: entry.value,
    secret: false,
    kind: "host" as const,
    occurrences: occurrencesOf(entry.value),
    reasonCode: single ? "single-origin" as const : "repeated-origin" as const,
    detail: single
      ? `All ${times(entry.count)} use the origin ${entry.value}`
      : `Origin ${entry.value} is used by ${times(entry.count)} (origin ${index + 1} of ${origins.length})`,
  }));
}

// Rule 2: one authToken for an Authorization value that repeats, or for the only
// value seen. Different values that never repeat are per-request tokens.
function authorizationSuggestions(
  requests: readonly ImportedRequest[],
  occurrencesOf: OccurrenceCounter,
  taken: Set<string>,
): HarVariableSuggestion[] {
  const groups = new Map<string, ValueGroup[]>();
  for (const request of requests) {
    const value = headerValue(request, "authorization");
    if (value === undefined || value.trim().length === 0) continue;
    addGrouped(groups, "authorization", value);
  }

  const values = groups.get("authorization") ?? [];
  const repeated = values.filter((entry) => entry.count >= 2);
  const candidates = repeated.length > 0 ? repeated : values.length === 1 ? values : [];

  return candidates.map((entry) => ({
    name: uniqueName(AUTHORIZATION_NAME, taken),
    value: entry.value,
    secret: true,
    kind: "authorization" as const,
    occurrences: occurrencesOf(entry.value),
    reasonCode: entry.count >= 2 ? "shared-authorization" as const : "single-authorization" as const,
    detail: entry.count >= 2
      ? `Authorization value is shared by ${times(entry.count)}`
      : "Authorization value appears once: replacing it keeps the credential out of the graph",
  }));
}

// Rule 3: one variable per cookie whose value never changes.
function cookieSuggestions(
  requests: readonly ImportedRequest[],
  occurrencesOf: OccurrenceCounter,
  taken: Set<string>,
): HarVariableSuggestion[] {
  const groups = new Map<string, ValueGroup[]>();
  for (const request of requests) {
    const header = headerValue(request, "cookie");
    if (header === undefined) continue;
    for (const pair of parseCookieHeader(header)) addGrouped(groups, pair.name, pair.value);
  }

  const suggestions: HarVariableSuggestion[] = [];
  for (const [name, values] of groups) {
    // Several values for one cookie name cannot share a single variable.
    if (values.length !== 1) continue;
    const [only] = values;
    suggestions.push({
      name: uniqueName(`${COOKIE_PREFIX}${sanitizedSegment(name)}`, taken),
      value: only.value,
      secret: true,
      kind: "cookie",
      occurrences: occurrencesOf(only.value),
      reasonCode: "cookie-value",
      detail: `Cookie "${name}" carries the same value in ${times(only.count)}`,
    });
  }
  return suggestions;
}

// Rule 4: one variable per API key header whose value never changes.
function apiKeySuggestions(
  requests: readonly ImportedRequest[],
  occurrencesOf: OccurrenceCounter,
  taken: Set<string>,
): HarVariableSuggestion[] {
  const groups = new Map<string, ValueGroup[]>();
  for (const request of requests) {
    for (const headerName of API_KEY_HEADERS) {
      const value = headerValue(request, headerName);
      if (value === undefined || value.trim().length === 0) continue;
      addGrouped(groups, headerName, value);
    }
  }

  const suggestions: HarVariableSuggestion[] = [];
  for (const [headerName, values] of groups) {
    // Several values for one header cannot share a single variable.
    if (values.length !== 1) continue;
    const [only] = values;
    suggestions.push({
      name: uniqueName(sanitizedSegment(headerName), taken),
      value: only.value,
      secret: true,
      kind: "api-key",
      occurrences: occurrencesOf(only.value),
      reasonCode: "api-key-header",
      detail: `Header "${headerName}" carries the same value in ${times(only.count)}`,
    });
  }
  return suggestions;
}

// Rule 5: query parameters whose name looks like a credential and whose value is
// long enough to be a real secret.
function querySuggestions(
  requests: readonly ImportedRequest[],
  occurrencesOf: OccurrenceCounter,
  taken: Set<string>,
): HarVariableSuggestion[] {
  const groups = new Map<string, ValueGroup[]>();
  for (const request of requests) {
    for (const [name, value] of queryPairs(request.url)) {
      if (!SECRET_QUERY_NAME.test(name)) continue;
      if (value.trim().length < MIN_SECRET_QUERY_VALUE_LENGTH) continue;
      addGrouped(groups, name, value);
    }
  }

  const suggestions: HarVariableSuggestion[] = [];
  for (const [name, values] of groups) {
    // Several values for one parameter cannot share a single variable.
    if (values.length !== 1) continue;
    const [only] = values;
    suggestions.push({
      name: uniqueName(sanitizedSegment(name), taken),
      value: only.value,
      secret: true,
      kind: "query",
      occurrences: occurrencesOf(only.value),
      reasonCode: "secret-query-param",
      detail: `Query parameter "${name}" carries the same secret in ${times(only.count)}`,
    });
  }
  return suggestions;
}

/**
 * Detects the values of an imported HAR graph that are worth a `{{name}}`
 * variable. Suggestions are returned in kind order (host, authorization, cookie,
 * api key, query) and never repeat a name.
 */
export function suggestHarVariables(
  graph: HarImportedGraph,
  composition?: GraphDraftComposition,
): HarVariableSuggestion[] {
  const requests = importedRequests(graph);
  const occurrencesOf = composition === undefined
    ? graphOccurrences(requests)
    : compositionOccurrences(composition);
  const taken = new Set<string>();

  return [
    ...hostSuggestions(requests, occurrencesOf, taken),
    ...authorizationSuggestions(requests, occurrencesOf, taken),
    ...cookieSuggestions(requests, occurrencesOf, taken),
    ...apiKeySuggestions(requests, occurrencesOf, taken),
    ...querySuggestions(requests, occurrencesOf, taken),
  ];
}

// -----------------------------------------------------------------------------
// Applying suggestions
// -----------------------------------------------------------------------------

interface Replacement {
  value: string;
  placeholder: string;
}

function replacementList(suggestions: readonly HarVariableSuggestion[]): Replacement[] {
  return suggestions
    .filter((suggestion) => isValidVariableName(suggestion.name)
      && typeof suggestion.value === "string" && suggestion.value.length > 0)
    .map((suggestion) => ({ value: suggestion.value, placeholder: `{{${suggestion.name}}}` }))
    // Longest value first, so a shorter value cannot eat part of a longer one.
    .sort((left, right) => right.value.length - left.value.length
      || (left.placeholder < right.placeholder ? -1 : left.placeholder > right.placeholder ? 1 : 0));
}

function replaceText(text: string, replacements: readonly Replacement[]): string {
  let result = text;
  for (const replacement of replacements) {
    if (!result.includes(replacement.value)) continue;
    result = result.split(replacement.value).join(replacement.placeholder);
  }
  return result;
}

function replaceStringParameter(
  value: StringParameterValue,
  replacements: readonly Replacement[],
): StringParameterValue {
  if (value.kind !== "literal") return value;
  const next = replaceText(value.value, replacements);
  return next === value.value ? value : { kind: "literal", value: next };
}

function replaceNamedValues(
  entries: HttpNamedValue[] | undefined,
  replacements: readonly Replacement[],
): HttpNamedValue[] | undefined {
  if (entries === undefined) return undefined;
  return entries.map((entry) => ({
    name: entry.name,
    value: replaceStringParameter(entry.value, replacements),
  }));
}

function replaceBody(
  body: HttpBody | undefined,
  replacements: readonly Replacement[],
): HttpBody | undefined {
  if (body === undefined || body.kind === "none") return body;
  const value = replaceStringParameter(body.value, replacements);
  switch (body.kind) {
    case "text": return { kind: "text", value };
    case "json": return { kind: "json", value };
    case "xml": return { kind: "xml", value };
    case "form": return { kind: "form", value };
  }
}

function replaceHttpParameters(
  parameters: HttpParameters,
  replacements: readonly Replacement[],
): HttpParameters {
  const next: HttpParameters = {
    method: parameters.method,
    url: replaceStringParameter(parameters.url, replacements),
  };
  const headers = replaceNamedValues(parameters.headers, replacements);
  if (headers !== undefined) next.headers = headers;
  const query = replaceNamedValues(parameters.query, replacements);
  if (query !== undefined) next.query = query;
  const body = replaceBody(parameters.body, replacements);
  if (body !== undefined) next.body = body;
  return next;
}

/**
 * Returns a new composition where every suggested value is replaced by its
 * `{{name}}` placeholder in the places it appears: the request url, header and
 * query values and the body text. The input is never mutated, and values the
 * suggestions do not name are left untouched.
 */
export function applyVariableSuggestions(
  composition: GraphDraftComposition,
  suggestions: readonly HarVariableSuggestion[],
): GraphDraftComposition {
  const replacements = replacementList(suggestions);
  const nodes = composition.nodes.map((node) => {
    if (node.kind !== "http-request" || node.parameters === undefined) return node;
    return { ...node, parameters: replaceHttpParameters(node.parameters, replacements) };
  });
  return { ...composition, nodes };
}
