/**
 * HAR import bridge (D5): `HarImportedGraph` -> `GraphDraftComposition`.
 *
 * `importHar` produces a graph shaped for the importer (`nodes` record,
 * `edges`, `startNode`) with flat request parameters (`method`, `url`,
 * `headers`, `body`, `contentType`). The editor validates and renders
 * `GraphDraftComposition` instead: an ordered node array with typed parameters,
 * a `connections` array and one linear chain. This module performs that
 * conversion so an imported scenario can be opened.
 */

import type { GraphDraftComposition } from "./graph-composition";
import { httpMethodSchema } from "./http-parameters";
import type { HttpBody, HttpNamedValue } from "./http-parameters";
import type { HarImportedGraph, HarImportedNode } from "./har-import";
import type { StringParameterValue } from "./parameter-values";
import { CONTRACT_VERSION } from "./version";

type DraftNode = GraphDraftComposition["nodes"][number];
type DraftConnection = GraphDraftComposition["connections"][number];

/** Importer node types: requests are graph nodes, steps are grouping only. */
const REQUEST_TYPE = "http_request";
const STEP_TYPE = "group";

const MAX_LABEL_LENGTH = 120;
const MAX_WAIT_SECONDS = 3600;
const FALLBACK_LABEL = "Request";
const FALLBACK_METHOD = "GET";

const literal = (value: string): StringParameterValue => ({ kind: "literal", value });

// -----------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------

function requestPath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  try {
    const pathname = new URL(trimmed).pathname;
    return pathname.length > 0 ? pathname : "/";
  } catch {
    return trimmed;
  }
}

function fallbackLabel(method: string, url: string): string {
  const combined = `${method} ${requestPath(url)}`.trim();
  return combined.length > 0 ? combined : FALLBACK_LABEL;
}

// The contract caps labels at 120 characters and rejects blank ones.
function boundedLabel(label: string): string {
  const bounded = label.slice(0, MAX_LABEL_LENGTH).trim();
  return bounded.length > 0 ? bounded : FALLBACK_LABEL;
}

function nodeLabel(node: HarImportedNode, method: string, url: string): string {
  const imported = typeof node.label === "string" ? node.label.trim() : "";
  const usable = imported.length > 0 && imported.length <= MAX_LABEL_LENGTH;
  return boundedLabel(usable ? imported : fallbackLabel(method, url));
}

// -----------------------------------------------------------------------------
// Parameters
// -----------------------------------------------------------------------------

function nodePosition(
  node: HarImportedNode,
  label: string,
  warnings: string[],
): { x: number; y: number } | undefined {
  const position: { x: number; y: number } | undefined = node.position;
  if (position === undefined) return undefined;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    warnings.push(`Dropped the position of "${label}": expected finite coordinates`);
    return undefined;
  }
  return { x: position.x, y: position.y };
}

// The importer maps HAR headers to `{key, value}`; the typed schema names the
// first field `name` and wraps the value in a literal parameter value.
function nodeHeaders(
  node: HarImportedNode,
  label: string,
  warnings: string[],
): HttpNamedValue[] | undefined {
  const imported: Array<{ key: string; value: string }> | undefined = node.parameters?.headers;
  if (!Array.isArray(imported) || imported.length === 0) return undefined;
  const headers: HttpNamedValue[] = [];
  for (const header of imported) {
    const name = typeof header?.key === "string" ? header.key.trim() : "";
    if (name.length === 0) {
      warnings.push(`Dropped a header with an empty name on "${label}"`);
      continue;
    }
    headers.push({ name, value: literal(typeof header.value === "string" ? header.value : "") });
  }
  return headers.length > 0 ? headers : undefined;
}

type BodyKind = "text" | "json" | "xml" | "form";

// Each typed body kind fixes the Content-Type the translator emits, so only a
// matching imported content type survives the conversion unchanged.
const BODY_CONTENT_TYPE: Readonly<Record<BodyKind, string>> = {
  json: "application/json",
  xml: "application/xml",
  form: "application/x-www-form-urlencoded",
  text: "text/plain",
};

const bodyFor = (kind: BodyKind, text: string): HttpBody => {
  const value = literal(text);
  switch (kind) {
    case "json": return { kind: "json", value };
    case "xml": return { kind: "xml", value };
    case "form": return { kind: "form", value };
    case "text": return { kind: "text", value };
  }
};

function contentTypeEssence(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function bodyKindForContentType(contentType: string): BodyKind | undefined {
  const essence = contentTypeEssence(contentType);
  if (essence.length === 0) return undefined;
  if (essence === BODY_CONTENT_TYPE.json || essence.endsWith("+json")) return "json";
  if (essence.includes("xml")) return "xml";
  if (essence === BODY_CONTENT_TYPE.form) return "form";
  if (essence === BODY_CONTENT_TYPE.text) return "text";
  return undefined;
}

function looksLikeFormBody(body: string): boolean {
  return /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(body);
}

function guessBodyKind(body: string): BodyKind {
  try {
    JSON.parse(body);
    return "json";
  } catch {
    // Not JSON: fall through to the textual shapes.
  }
  return looksLikeFormBody(body) ? "form" : "text";
}

function nodeBody(
  node: HarImportedNode,
  label: string,
  warnings: string[],
): HttpBody | undefined {
  const body: string | undefined =
    typeof node.parameters?.body === "string" ? node.parameters.body : undefined;
  const contentType: string =
    typeof node.parameters?.contentType === "string" ? node.parameters.contentType.trim() : "";

  if (body === undefined) {
    if (contentType.length > 0) {
      warnings.push(`Dropped content type "${contentType}" on "${label}": the request has no body`);
    }
    return undefined;
  }

  if (contentType.length === 0) {
    const kind = guessBodyKind(body);
    warnings.push(`No content type on "${label}": the body was imported as ${kind}`);
    return bodyFor(kind, body);
  }

  const kind = bodyKindForContentType(contentType);
  if (kind === undefined) {
    warnings.push(`Content type "${contentTypeEssence(contentType)}" on "${label}" `
      + "cannot be represented by the typed body; the body was imported as text");
    return bodyFor("text", body);
  }
  return bodyFor(kind, body);
}

function toDraftNode(node: HarImportedNode, warnings: string[]): DraftNode {
  const rawMethod = typeof node.parameters?.method === "string" ? node.parameters.method.trim() : "";
  const method = httpMethodSchema.safeParse(rawMethod).success ? rawMethod : FALLBACK_METHOD;
  const url = typeof node.parameters?.url === "string" ? node.parameters.url : "";
  const label = nodeLabel(node, method, url);

  if (method !== rawMethod) {
    warnings.push(`Invalid HTTP method "${rawMethod}" on "${label}": replaced with ${FALLBACK_METHOD}`);
  }

  const position = nodePosition(node, label, warnings);
  const headers = nodeHeaders(node, label, warnings);
  const body = nodeBody(node, label, warnings);

  const draft: DraftNode = {
    id: node.id,
    kind: "http-request",
    references: [],
    label,
    parameters: {
      method,
      url: literal(url),
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    },
  };
  if (position !== undefined) draft.position = position;
  return draft;
}

// -----------------------------------------------------------------------------
// Ordering: steps decide the chain, requests are the only graph nodes
// -----------------------------------------------------------------------------

interface OrderedRequest {
  node: HarImportedNode;
  /** Wait carried by the edge that enters this request (or its step). */
  waitSeconds?: number;
  /** False when the imported edges never reached the request. */
  reached: boolean;
}

function orderRequests(graph: HarImportedGraph, warnings: string[]): OrderedRequest[] {
  const nodes = Object.values(graph.nodes ?? {});
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  const outgoing = new Map<string, Array<{ to: string; waitSeconds?: number }>>();
  for (const edge of graph.edges ?? []) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push({ to: edge.to, waitSeconds: edge.waitSeconds });
    outgoing.set(edge.from, targets);
  }

  // Step children are stored as a flat record, so their insertion order is the
  // import order the importer wrote them in.
  const children = new Map<string, HarImportedNode[]>();
  for (const node of nodes) {
    if (typeof node.parentId !== "string") continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }

  const ordered: OrderedRequest[] = [];
  const visited = new Set<string>();
  const start = typeof graph.startNode === "string" && byId.has(graph.startNode)
    ? graph.startNode
    : nodes[0]?.id;
  let current: string | undefined = start;
  let incomingWait: number | undefined;

  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const node = byId.get(current);
    if (node === undefined) break;
    const wait = incomingWait;

    if (node.type === REQUEST_TYPE) {
      ordered.push({ node, waitSeconds: wait, reached: true });
    } else if (node.type === STEP_TYPE) {
      // A step is grouping only: its requests join the chain in import order and
      // the wait on the edge entering the step lands on its first request.
      const stepRequests = (children.get(node.id) ?? [])
        .filter((child) => child.type === REQUEST_TYPE);
      stepRequests.forEach((child, index) => {
        visited.add(child.id);
        ordered.push({ node: child, waitSeconds: index === 0 ? wait : undefined, reached: true });
      });
    } else {
      warnings.push(`Dropped node "${node.label}" of unsupported type "${node.type}": `
        + "it is not a graph node");
    }

    const next: { to: string; waitSeconds?: number } | undefined =
      (outgoing.get(current) ?? []).find((edge) => !visited.has(edge.to) && byId.has(edge.to));
    current = next?.to;
    incomingWait = next?.waitSeconds;
  }

  // A single linear chain is what makes the graph openable, so unreached
  // requests are appended in import order instead of being lost.
  for (const node of nodes) {
    if (visited.has(node.id) || node.type !== REQUEST_TYPE) continue;
    ordered.push({ node, reached: false });
  }

  return ordered;
}

// -----------------------------------------------------------------------------
// Connections
// -----------------------------------------------------------------------------

function sanitizeWait(
  wait: unknown,
  label: string | undefined,
  warnings: string[],
): number | undefined {
  if (wait === undefined || wait === null) return undefined;
  if (typeof wait === "number" && Number.isFinite(wait) && wait >= 0 && wait <= MAX_WAIT_SECONDS) {
    return wait;
  }
  warnings.push(`Dropped wait of ${String(wait)} seconds on the connection into "${label ?? ""}": `
    + `expected a finite value between 0 and ${MAX_WAIT_SECONDS}`);
  return undefined;
}

/**
 * Convert an imported HAR graph into the editor composition plus the warnings
 * for everything the typed composition cannot represent faithfully.
 */
export function harGraphToComposition(
  graph: HarImportedGraph,
): { composition: GraphDraftComposition; warnings: string[] } {
  const warnings: string[] = [];
  const ordered = orderRequests(graph, warnings);

  const nodes: DraftNode[] = [];
  const entryWaits: Array<number | undefined> = [];
  for (const entry of ordered) {
    const node = toDraftNode(entry.node, warnings);
    if (!entry.reached) {
      warnings.push(`Node "${node.label}" was not reachable from the imported start node: `
        + "appended in import order");
    }
    nodes.push(node);
    entryWaits.push(entry.waitSeconds);
  }

  const connections: DraftConnection[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const source = nodes[index - 1].id;
    const target = nodes[index].id;
    const waitSeconds = sanitizeWait(entryWaits[index], nodes[index].label, warnings);
    connections.push(waitSeconds === undefined
      ? { source, target }
      : { source, target, waitSeconds });
  }

  return { composition: { version: CONTRACT_VERSION, nodes, connections }, warnings };
}
