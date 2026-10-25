/**
 * Save a processed recording as a new scenario.
 */

import { CONTRACT_VERSION } from "@k6flow/shared";
import type { NDJSONNetworkEntry } from "@k6flow/shared";
import type { HttpParameters, HttpNamedValue, HttpBody, GraphDraftComposition } from "@k6flow/shared";

/**
 * Entry from review UI with step context.
 */
export interface ReviewedEntry {
  entry: NDJSONNetworkEntry["data"];
  stepId: string;
  stepName: string;
  thinkTime: number;
}

/**
 * Graph node for HTTP request.
 */
export interface RecordingGraphNode {
  id: string;
  kind: "http-request";
  references: [];
  label: string;
  position: { x: number; y: number };
  parameters: HttpParameters;
}

/** The editor lays nodes out left to right at this spacing. */
const NODE_SPACING_X = 250;
const INITIAL_POSITION = { x: 100, y: 100 };

/** Node labels are shown in the editor and capped by the graph contract. */
const MAX_LABEL_LENGTH = 120;

/** Longest pause the connection schema accepts. */
const MAX_WAIT_SECONDS = 3600;

// Headers to exclude from recording
const EXCLUDE_HEADERS = new Set([
  "connection", "keep-alive", "host", "content-length",
  "accept-encoding", "transfer-encoding", "cookie",
]);

/**
 * Convert reviewed entries to graph format for scenario.
 */
export function reviewedEntriesToGraph(
  entries: ReviewedEntry[]
): { nodes: RecordingGraphNode[]; connections: Array<{ source: string; target: string }> } {
  const nodes: RecordingGraphNode[] = entries.map((e, index) => {
    const url = new URL(e.entry.request.url);
    
    // Convert headers
    const headers: HttpNamedValue[] = Object.entries(e.entry.request.headers)
      .filter(([name]) => !EXCLUDE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => ({
        name,
        value: { kind: "literal" as const, value },
      }));

    // Extract query params
    const query: HttpNamedValue[] = Array.from(url.searchParams.entries()).map(
      ([name, value]) => ({
        name,
        value: { kind: "literal" as const, value },
      })
    );

    // Build base URL without query
    const baseUrl = `${url.origin}${url.pathname}`;

    // Parse body if present
    let body: HttpBody | undefined;
    if (e.entry.request.postData) {
      const contentType = e.entry.request.headers["content-type"] || "";
      if (contentType.includes("application/json")) {
        // The contract keeps a JSON body as its JSON text, never as a parsed object.
        body = { kind: "json", value: { kind: "literal", value: e.entry.request.postData } };
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        // Form data as text body
        body = { kind: "text", value: { kind: "literal", value: e.entry.request.postData } };
      } else {
        body = { kind: "text", value: { kind: "literal", value: e.entry.request.postData } };
      }
    }

    const parameters: HttpParameters = {
      method: e.entry.request.method,
      url: { kind: "literal", value: baseUrl },
      ...(headers.length > 0 && { headers }),
      ...(query.length > 0 && { query }),
      ...(body && { body }),
    };

    return {
      id: `rec-${index + 1}`,
      kind: "http-request" as const,
      references: [] as [],
      label: labelFor(e.entry.request.method, baseUrl, index),
      position: {
        x: INITIAL_POSITION.x + index * NODE_SPACING_X,
        y: INITIAL_POSITION.y,
      },
      parameters,
    };
  });

  // Generate sequential connections
  const connections = nodes.slice(0, -1).map((node, i) => ({
    source: node.id,
    target: nodes[i + 1].id,
  }));

  return { nodes, connections };
}

/** `GET /login` — short, stable and non-blank, as the graph contract requires. */
function labelFor(method: string, baseUrl: string, index: number): string {
  let pathname = "";
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    pathname = "";
  }
  const label = `${method} ${pathname}`.trim();
  return (label === "" ? `Request ${index + 1}` : label).slice(0, MAX_LABEL_LENGTH);
}

/**
 * Create a scenario graph from reviewed recording data.
 *
 * The result is a draft composition — the shape the editor loads — so a saved
 * recording opens straight into the canvas. Each step's think time becomes the
 * wait on the connection that leads into it, which is how the translator emits
 * the pause in the k6 script.
 */
export function createScenarioGraph(entries: ReviewedEntry[]): GraphDraftComposition {
  const { nodes, connections } = reviewedEntriesToGraph(entries);

  return {
    version: CONTRACT_VERSION,
    nodes,
    connections: connections.map((connection, index) => {
      const thinkTime = entries[index + 1]?.thinkTime ?? 0;
      const waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(thinkTime) || 0));
      return {
        source: connection.source,
        target: connection.target,
        ...(waitSeconds > 0 && { waitSeconds }),
      };
    }),
  };
}
