/**
 * K6F8-01: Capture-to-graph translator.
 *
 * Converts recorded HTTP traffic (RecorderCaptureEntry[]) into graph nodes
 * for the visual editor. This is the inverse of the K6 translator.
 */

import type { RecorderCaptureEntry, RecorderHeaderEntry } from "./recorder-contracts";
import type { HttpParameters, HttpNamedValue, HttpBody } from "./http-parameters";
import type { StringParameterValue, JsonParameterValue } from "./parameter-values";

/**
 * A graph node generated from a capture entry.
 */
export interface CaptureGraphNode {
  id: string;
  kind: "http-request";
  references: Record<string, never>;
  parameters: HttpParameters;
  /** Original capture metadata for reference */
  meta: {
    originalStatus: number;
    redacted: boolean;
  };
}

/**
 * Options for capture-to-graph conversion.
 */
export interface CaptureToGraphOptions {
  /** Prefix for generated node IDs (default: "capture") */
  idPrefix?: string;
  /** Headers to exclude from conversion (case-insensitive) */
  excludeHeaders?: string[];
  /** Whether to include response status in node metadata */
  includeMetadata?: boolean;
}

const DEFAULT_EXCLUDE_HEADERS = [
  // Hop-by-hop headers that shouldn't be replayed
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  // Headers that will be set by K6
  "host",
  "content-length",
  "accept-encoding",
];

/**
 * Convert a single capture entry to a graph node.
 */
export function captureToNode(
  entry: RecorderCaptureEntry,
  index: number,
  options: CaptureToGraphOptions = {}
): CaptureGraphNode {
  const {
    idPrefix = "capture",
    excludeHeaders = DEFAULT_EXCLUDE_HEADERS,
    includeMetadata = true,
  } = options;

  const excludeSet = new Set(excludeHeaders.map((h) => h.toLowerCase()));

  // Convert headers
  const headers: HttpNamedValue[] = entry.headers
    .filter((h) => !excludeSet.has(h.name.toLowerCase()))
    .map((h) => ({
      name: h.name,
      value: { kind: "literal" as const, value: h.value },
    }));

  // Parse URL for query parameters
  const { baseUrl, queryParams } = parseUrl(entry.url);

  // Convert body
  const body = parseBody(entry.bodyExcerpt, entry.headers);

  const parameters: HttpParameters = {
    method: entry.method,
    url: { kind: "literal", value: baseUrl },
    ...(headers.length > 0 && { headers }),
    ...(queryParams.length > 0 && { query: queryParams }),
    ...(body && { body }),
  };

  return {
    id: `${idPrefix}-${index}`,
    kind: "http-request",
    references: {},
    parameters,
    meta: {
      originalStatus: entry.status,
      redacted: entry.redacted,
    },
  };
}

/**
 * Convert multiple capture entries to graph nodes.
 */
export function capturesToGraph(
  entries: RecorderCaptureEntry[],
  options: CaptureToGraphOptions = {}
): CaptureGraphNode[] {
  return entries.map((entry, index) => captureToNode(entry, index, options));
}

/**
 * Parse URL into base URL and query parameters.
 */
function parseUrl(url: string): { baseUrl: string; queryParams: HttpNamedValue[] } {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return { baseUrl: url, queryParams: [] };
  }

  const baseUrl = url.slice(0, queryIndex);
  const queryString = url.slice(queryIndex + 1);
  const queryParams: HttpNamedValue[] = [];

  for (const pair of queryString.split("&")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const name = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    queryParams.push({
      name,
      value: { kind: "literal", value },
    });
  }

  return { baseUrl, queryParams };
}

/**
 * Parse body content based on Content-Type header.
 */
function parseBody(
  bodyExcerpt: string | undefined,
  headers: RecorderHeaderEntry[]
): HttpBody | undefined {
  if (!bodyExcerpt || bodyExcerpt === "[binary content]") {
    return undefined;
  }

  const contentType = headers
    .find((h) => h.name.toLowerCase() === "content-type")
    ?.value.toLowerCase();

  if (contentType?.includes("application/json")) {
    try {
      // Validate it's valid JSON
      JSON.parse(bodyExcerpt);
      const jsonValue: JsonParameterValue = { kind: "literal", value: bodyExcerpt };
      return { kind: "json", value: jsonValue };
    } catch {
      // If not valid JSON, treat as text
      const textValue: StringParameterValue = { kind: "literal", value: bodyExcerpt };
      return { kind: "text", value: textValue };
    }
  }

  // Default to text body
  const textValue: StringParameterValue = { kind: "literal", value: bodyExcerpt };
  return { kind: "text", value: textValue };
}

/**
 * Generate connections between sequential nodes.
 * Each node connects to the next in order.
 */
export function generateConnections(
  nodes: CaptureGraphNode[]
): Array<{ source: string; target: string }> {
  const connections: Array<{ source: string; target: string }> = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    connections.push({
      source: nodes[i].id,
      target: nodes[i + 1].id,
    });
  }

  return connections;
}
