// k6flow-variables V-T4: pure token logic for `{{name}}` highlighting and
// autocomplete in the editor fields. No React and no DOM.

import { findVariables, parseTemplate } from "@k6flow/shared";

export type HighlightSegment =
  | { type: "text"; value: string }
  | { type: "known"; name: string }
  | { type: "unknown"; name: string };

/** Splits text into literal text and known/unknown variable tokens. */
export function segmentTemplate(
  text: string,
  known: ReadonlySet<string> | readonly string[],
): HighlightSegment[] {
  const names: ReadonlySet<string> = known instanceof Set ? known : new Set(known as readonly string[]);
  return parseTemplate(text).map((segment): HighlightSegment => {
    if (segment.type === "text") return segment;
    return { type: names.has(segment.name) ? "known" : "unknown", name: segment.name };
  });
}

/** Range to replace with `{{name}}` and the partial name typed so far. */
export interface AutocompleteContext {
  /** Index of the opening `{{`. */
  start: number;
  /** End (exclusive) of the replaced range: caret, rest of the name and an existing `}}`. */
  end: number;
  /** Partial name between `{{` (leading whitespace ignored) and the caret. */
  query: string;
}

const PARTIAL_NAME = /^\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})?$/;
const NAME_TAIL_WITH_CLOSE = /^[A-Za-z0-9_.-]*\s*\}\}/;
const NAME_TAIL = /^[A-Za-z0-9_.-]*/;

/** Autocomplete context when the caret sits inside an open `{{` placeholder, else null. */
export function getAutocompleteContext(text: string, caret: number): AutocompleteContext | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start === -1) return null;
  const inner = before.slice(start + 2);
  if (inner.includes("}")) return null;
  const match = PARTIAL_NAME.exec(inner);
  if (!match) return null;
  const after = text.slice(caret);
  const tail = NAME_TAIL_WITH_CLOSE.exec(after) ?? NAME_TAIL.exec(after);
  return { start, end: caret + (tail ? tail[0].length : 0), query: match[1] ?? "" };
}

/** Names matching the query: prefix matches first, then substring matches (case-insensitive). */
export function filterVariableNames(names: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const prefix = sorted.filter((name) => name.toLowerCase().startsWith(q));
  const contains = sorted.filter((name) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q));
  return [...prefix, ...contains];
}

/** Replaces the context range with `{{name}}`; the caret lands right after it. */
export function applyAutocomplete(
  text: string,
  context: AutocompleteContext,
  name: string,
): { text: string; caret: number } {
  const token = `{{${name}}}`;
  return {
    text: text.slice(0, context.start) + token + text.slice(context.end),
    caret: context.start + token.length,
  };
}

/** Minimal node shape: React Flow nodes and graph nodes both fit. */
export interface GraphNodeLike {
  data?: { kind?: string; parameters?: unknown };
}

type Literal = { kind?: unknown; value?: unknown };

function literalText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const literal = value as Literal;
  return literal.kind === "literal" && typeof literal.value === "string" ? literal.value : null;
}

/**
 * Variable names used by the graph, in first-appearance order. Mirrors the fields the
 * translator interpolates: HTTP Request URL, literal header values and body, and the
 * Authentication request URL.
 */
export function collectGraphVariables(nodes: readonly GraphNodeLike[]): string[] {
  const names = new Set<string>();
  const add = (text: string | null) => {
    if (text === null) return;
    for (const name of findVariables(text)) names.add(name);
  };
  for (const node of nodes) {
    const params = node.data?.parameters as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object") continue;
    if (node.data?.kind === "http-request") {
      add(literalText(params.url));
      if (Array.isArray(params.headers)) {
        for (const header of params.headers as { value?: unknown }[]) add(literalText(header?.value));
      }
      const body = params.body as { kind?: unknown; value?: unknown } | undefined;
      if (body && body.kind !== "none") add(literalText(body.value));
    } else if (node.data?.kind === "authentication") {
      const method = params.method as { request?: { url?: unknown } } | undefined;
      add(literalText(method?.request?.url));
    }
  }
  return [...names];
}
