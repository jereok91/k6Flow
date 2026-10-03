/**
 * Save a processed recording as a new scenario.
 */

import type { NDJSONNetworkEntry } from "@k6flow/shared";
import type { HttpParameters, HttpNamedValue, HttpBody } from "@k6flow/shared";

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
  references: Record<string, never>;
  parameters: HttpParameters;
  meta: {
    originalStatus: number;
    stepId: string;
    stepName: string;
    thinkTime: number;
  };
}

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
        try {
          body = {
            kind: "json",
            value: { kind: "literal", value: JSON.parse(e.entry.request.postData) },
          };
        } catch {
          body = { kind: "text", value: { kind: "literal", value: e.entry.request.postData } };
        }
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
      id: `rec-${index}`,
      kind: "http-request" as const,
      references: {},
      parameters,
      meta: {
        originalStatus: e.entry.response?.status ?? 0,
        stepId: e.stepId,
        stepName: e.stepName,
        thinkTime: e.thinkTime,
      },
    };
  });

  // Generate sequential connections
  const connections = nodes.slice(0, -1).map((node, i) => ({
    source: node.id,
    target: nodes[i + 1].id,
  }));

  return { nodes, connections };
}

/**
 * Create a scenario graph from reviewed recording data.
 */
export function createScenarioGraph(
  entries: ReviewedEntry[],
  metadata: {
    name: string;
    startUrl: string;
    viewport: { width: number; height: number };
    recordingId?: string;
  }
) {
  const { nodes, connections } = reviewedEntriesToGraph(entries);

  // Build graph structure matching editor format
  const graph = {
    version: 1,
    metadata: {
      name: metadata.name,
      recordingSource: {
        url: metadata.startUrl,
        viewport: metadata.viewport,
        recordingId: metadata.recordingId,
        capturedAt: new Date().toISOString(),
      },
    },
    nodes: Object.fromEntries(
      nodes.map((node) => [
        node.id,
        {
          kind: node.kind,
          references: node.references,
          parameters: node.parameters,
        },
      ])
    ),
    edges: connections.map((conn) => ({
      id: `${conn.source}-${conn.target}`,
      source: conn.source,
      target: conn.target,
    })),
    // Position nodes vertically
    positions: Object.fromEntries(
      nodes.map((node, index) => [
        node.id,
        { x: 400, y: 100 + index * 100 },
      ])
    ),
  };

  return graph;
}
