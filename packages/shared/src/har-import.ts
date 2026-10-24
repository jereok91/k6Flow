/**
 * HAR (HTTP Archive) import - convert HAR files to K6Flow scenarios
 */

// Simple ID generator
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Simplified graph types for HAR import (independent of internal schemas)
export interface HarImportedNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  parameters: {
    method?: string;
    url?: string;
    headers?: Array<{ key: string; value: string }>;
    body?: string;
    contentType?: string;
  };
  parentId?: string;
}

export interface HarImportedGraph {
  nodes: Record<string, HarImportedNode>;
  edges: Array<{ from: string; to: string; waitSeconds?: number }>;
  startNode?: string;
}

// Resource type vocabulary DevTools uses in its Network panel filter row. The
// importer classifies every entry into exactly one of these (D2).
export const HAR_RESOURCE_TYPES = [
  "document",
  "xhr",
  "fetch",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "websocket",
  "other",
] as const;

export type HarResourceType = (typeof HAR_RESOURCE_TYPES)[number];

const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(HAR_RESOURCE_TYPES);

// Chrome/Edge write `_resourceType` with their own capitalisation ("Fetch",
// "Stylesheet", ...). Lowercased names map to the shared vocabulary; the kinds
// DevTools shows outside the filter row collapse into "other".
const RESOURCE_TYPE_ALIASES: Readonly<Record<string, HarResourceType>> = {
  document: "document",
  xhr: "xhr",
  fetch: "fetch",
  script: "script",
  stylesheet: "stylesheet",
  image: "image",
  font: "font",
  media: "media",
  websocket: "websocket",
  other: "other",
  manifest: "other",
  texttrack: "other",
  ping: "other",
  prefetch: "other",
  signedexchange: "other",
};

export function isHarResourceType(value: unknown): value is HarResourceType {
  return typeof value === "string" && RESOURCE_TYPE_SET.has(value);
}

// HAR 1.2 types (simplified)
export interface HarEntry {
  /** DevTools extension (Chrome/Edge): "Document", "XHR", "Fetch", ... */
  _resourceType?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: {
      mimeType: string;
      text?: string;
      params?: Array<{ name: string; value: string }>;
    };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    content: {
      size: number;
      mimeType: string;
      text?: string;
    };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, unknown>;
  timings: {
    blocked?: number;
    dns?: number;
    connect?: number;
    ssl?: number;
    send: number;
    wait: number;
    receive: number;
  };
}

export interface HarLog {
  version: string;
  creator: {
    name: string;
    version: string;
  };
  entries: HarEntry[];
  pages?: Array<{
    startedDateTime: string;
    id: string;
    title: string;
  }>;
}

export interface Har {
  log: HarLog;
}

export interface HarImportOptions {
  name: string;
  /** Filter requests by URL pattern */
  urlFilter?: RegExp;
  /** Exclude static assets */
  excludeStatic?: boolean;
  /** Include only main document requests */
  mainDocumentsOnly?: boolean;
  /** Group requests into steps by time gap (ms) */
  stepGapMs?: number;
  /**
   * Keep only these resource types. Absent or empty means every type, and
   * values inside one kind are ORed (D1).
   */
  includeResourceTypes?: readonly HarResourceType[];
  /** Drop these resource types. Absent or empty drops nothing. */
  excludeResourceTypes?: readonly HarResourceType[];
  /** Keep only these HTTP methods (case-insensitive). Absent or empty keeps all. */
  methods?: readonly string[];
  /** Inclusive lower bound on the response status. */
  statusMin?: number;
  /** Inclusive upper bound on the response status. */
  statusMax?: number;
  /** Keep only requests whose host is one of these domains or a subdomain. */
  includeDomains?: readonly string[];
  /** Drop requests whose host is one of these domains or a subdomain. */
  excludeDomains?: readonly string[];
  /**
   * Derive each connection's `waitSeconds` from the HAR timings (default true).
   * Set false to import the same graph without waits.
   */
  useHarTimings?: boolean;
}

export interface HarImportResult {
  graph: HarImportedGraph;
  stats: {
    totalEntries: number;
    importedEntries: number;
    skippedEntries: number;
    steps: number;
  };
  warnings: string[];
}

// Static asset extensions
const STATIC_EXTENSIONS = new Set([
  ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".map", ".webp", ".avif",
]);

// Third-party domains commonly filtered
const THIRD_PARTY_PATTERNS = [
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /facebook\.net/,
  /doubleclick\.net/,
  /hotjar\.com/,
  /segment\.io/,
  /amplitude\.com/,
  /mixpanel\.com/,
  /sentry\.io/,
];

function isStaticAsset(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return STATIC_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf(".")));
  } catch {
    return false;
  }
}

function isThirdParty(url: string, baseHost?: string): boolean {
  try {
    const host = new URL(url).host;
    if (baseHost && host !== baseHost) {
      return THIRD_PARTY_PATTERNS.some((p) => p.test(host));
    }
    return false;
  } catch {
    return false;
  }
}

function classifyMimeType(mimeType: string): HarResourceType {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime.length === 0) return "other";
  if (mime.includes("html")) return "document";
  if (mime.includes("css")) return "stylesheet";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return "script";
  if (mime.startsWith("image/")) return "image";
  // font/woff2, application/font-woff, application/x-font-ttf, ...
  if (mime.startsWith("font/") || mime.includes("font") || mime.includes("woff")
    || mime.includes("truetype") || mime.includes("opentype")) return "font";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
  // XHR and fetch share the same payload mime types; without `_resourceType`
  // the DevTools default for structured payloads is XHR.
  if (mime === "application/json" || mime.endsWith("+json")
    || mime.includes("xml") || mime === "application/x-www-form-urlencoded") return "xhr";
  return "other";
}

function hasWebSocketUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith("ws://") || lower.startsWith("wss://");
}

/**
 * Classify a HAR entry into the DevTools resource type vocabulary (D2).
 * `_resourceType` wins when the export carries a known DevTools name; otherwise
 * the response `content.mimeType` decides, and anything unrecognised is
 * `other`.
 */
export function classifyHarEntry(entry: HarEntry): HarResourceType {
  const declared = typeof entry._resourceType === "string"
    ? entry._resourceType.trim().toLowerCase()
    : "";
  const aliased = declared.length > 0 ? RESOURCE_TYPE_ALIASES[declared] : undefined;
  if (aliased !== undefined) return aliased;
  if (hasWebSocketUrl(entry.request.url)) return "websocket";
  return classifyMimeType(entry.response?.content?.mimeType ?? "");
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

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

type FilterList<T> = readonly T[] | undefined;

function toFilterSet<T>(values: FilterList<T>): Set<T> | undefined {
  return values && values.length > 0 ? new Set(values) : undefined;
}

// Waits are clamped to the same range the graph contract allows (0..3600 s).
const MAX_HAR_WAIT_SECONDS = 3600;

/**
 * Gap, in seconds, between the end of one imported entry and the start of the
 * next one. Negative and non-finite gaps become 0 (the requests overlap), and
 * anything above the contract maximum is clamped to 3600 (D3).
 */
function harGapSeconds(previous: HarEntry, next: HarEntry): number {
  const previousStart = new Date(previous.startedDateTime).getTime();
  const nextStart = new Date(next.startedDateTime).getTime();
  const previousTime = Number.isFinite(previous.time) ? previous.time : 0;
  const gapSeconds = (nextStart - (previousStart + previousTime)) / 1000;
  if (!Number.isFinite(gapSeconds) || gapSeconds <= 0) return 0;
  return Math.min(Math.round(gapSeconds * 1000) / 1000, MAX_HAR_WAIT_SECONDS);
}

interface SimpleHttpParams {
  method: string;
  url: string;
  headers?: Array<{ key: string; value: string }>;
  body?: string;
  contentType?: string;
}

function entryToHttpParams(entry: HarEntry): SimpleHttpParams {
  // Extract headers (skip pseudo-headers and common browser headers)
  const skipHeaders = new Set([
    "host", "connection", "content-length", "accept-encoding",
    "user-agent", "accept", "accept-language", "cache-control",
    "pragma", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    "upgrade-insecure-requests", "referer", "origin",
  ]);
  
  const headers: Array<{ key: string; value: string }> = [];
  for (const h of entry.request.headers) {
    const name = h.name.toLowerCase();
    if (!skipHeaders.has(name) && !name.startsWith(":")) {
      headers.push({ key: h.name, value: h.value });
    }
  }

  // Build body
  let body: string | undefined;
  let contentType: string | undefined;
  
  if (entry.request.postData) {
    contentType = entry.request.postData.mimeType;
    if (entry.request.postData.text) {
      body = entry.request.postData.text;
    } else if (entry.request.postData.params) {
      body = entry.request.postData.params
        .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
        .join("&");
    }
  }

  return {
    method: entry.request.method,
    url: entry.request.url,
    headers: headers.length > 0 ? headers : undefined,
    body,
    contentType,
  };
}

/**
 * Import HAR file and convert to K6Flow scenario graph
 */
export function importHar(har: Har, options: HarImportOptions): HarImportResult {
  const warnings: string[] = [];
  const entries = har.log.entries;
  
  if (!entries || entries.length === 0) {
    return {
      graph: {
        nodes: {},
        edges: [],
        startNode: undefined,
      },
      stats: { totalEntries: 0, importedEntries: 0, skippedEntries: 0, steps: 0 },
      warnings: ["HAR file contains no entries"],
    };
  }

  // Get base host from first entry
  let baseHost: string | undefined;
  try {
    baseHost = new URL(entries[0].request.url).host;
  } catch {
    // ignore
  }

  // Filter entries
  const filtered: HarEntry[] = [];
  let skipped = 0;

  // New filters combine with AND across kinds and OR inside one kind (D1).
  const includedTypes = toFilterSet(options.includeResourceTypes);
  const excludedTypes = toFilterSet(options.excludeResourceTypes);
  const allowedMethods = toFilterSet(
    options.methods
      ?.map((method) => method.trim().toUpperCase())
      .filter((method) => method.length > 0),
  );
  const includedDomains = normalizeDomains(options.includeDomains);
  const excludedDomains = normalizeDomains(options.excludeDomains);
  const { statusMin, statusMax } = options;

  for (const entry of entries) {
    // URL filter
    if (options.urlFilter && !options.urlFilter.test(entry.request.url)) {
      skipped++;
      continue;
    }

    // Exclude static assets
    if (options.excludeStatic && isStaticAsset(entry.request.url)) {
      skipped++;
      continue;
    }

    // Third-party filter
    if (options.excludeStatic && isThirdParty(entry.request.url, baseHost)) {
      skipped++;
      continue;
    }

    // Main documents only
    if (options.mainDocumentsOnly) {
      const contentType = entry.response.content.mimeType || "";
      if (!contentType.includes("text/html")) {
        skipped++;
        continue;
      }
    }

    // Resource type
    if (includedTypes || excludedTypes) {
      const resourceType = classifyHarEntry(entry);
      if (includedTypes && !includedTypes.has(resourceType)) {
        skipped++;
        continue;
      }
      if (excludedTypes && excludedTypes.has(resourceType)) {
        skipped++;
        continue;
      }
    }

    // Allowed methods
    if (allowedMethods && !allowedMethods.has(entry.request.method.trim().toUpperCase())) {
      skipped++;
      continue;
    }

    // Inclusive status range
    if (statusMin !== undefined && entry.response.status < statusMin) {
      skipped++;
      continue;
    }
    if (statusMax !== undefined && entry.response.status > statusMax) {
      skipped++;
      continue;
    }

    // Domains: allow list first, then deny list
    if (includedDomains || excludedDomains) {
      const host = hostOf(entry.request.url) ?? "";
      if (includedDomains && !includedDomains.some((domain) => hostMatchesDomain(host, domain))) {
        skipped++;
        continue;
      }
      if (host.length > 0
        && excludedDomains?.some((domain) => hostMatchesDomain(host, domain))) {
        skipped++;
        continue;
      }
    }

    filtered.push(entry);
  }

  if (filtered.length === 0) {
    return {
      graph: {
        nodes: {},
        edges: [],
        startNode: undefined,
      },
      stats: { totalEntries: entries.length, importedEntries: 0, skippedEntries: skipped, steps: 0 },
      warnings: ["No entries matched import filters"],
    };
  }

  // Sort by time
  filtered.sort((a, b) => 
    new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime()
  );

  // Group into steps based on time gap
  const stepGapMs = options.stepGapMs ?? 2000;
  const steps: HarEntry[][] = [];
  let currentStep: HarEntry[] = [];
  let lastTime = 0;

  for (const entry of filtered) {
    const entryTime = new Date(entry.startedDateTime).getTime();
    
    if (currentStep.length === 0) {
      currentStep.push(entry);
      lastTime = entryTime;
    } else if (entryTime - lastTime > stepGapMs) {
      // Start new step
      steps.push(currentStep);
      currentStep = [entry];
      lastTime = entryTime;
    } else {
      currentStep.push(entry);
      lastTime = entryTime;
    }
  }
  
  if (currentStep.length > 0) {
    steps.push(currentStep);
  }

  // Build graph
  const nodes: HarImportedGraph["nodes"] = {};
  const edges: HarImportedGraph["edges"] = [];
  const useHarTimings = options.useHarTimings ?? true;
  let prevNodeId: string | undefined;
  // Last entry of the previous step: the request whose end anchors the wait
  // written on the connection into the next step's node.
  let prevStepLastEntry: HarEntry | undefined;
  let stepIndex = 0;

  for (const step of steps) {
    stepIndex++;

    // Requests inside one step run together (they become a group), so only the
    // boundary between steps has a single request to wait after.
    const waitSeconds = useHarTimings && prevStepLastEntry
      ? harGapSeconds(prevStepLastEntry, step[0])
      : undefined;
    const edgeTo = (nodeId: string) => {
      if (!prevNodeId) return;
      edges.push({
        from: prevNodeId,
        to: nodeId,
        ...(waitSeconds === undefined ? {} : { waitSeconds }),
      });
    };

    // Create a group node for the step if multiple requests
    if (step.length === 1) {
      const entry = step[0];
      const nodeId = randomId();
      const httpParams = entryToHttpParams(entry);
      
      nodes[nodeId] = {
        id: nodeId,
        type: "http_request",
        label: `Step ${stepIndex}: ${entry.request.method} ${new URL(entry.request.url).pathname}`,
        position: { x: 100, y: stepIndex * 100 },
        parameters: httpParams,
      };

      edgeTo(nodeId);
      prevNodeId = nodeId;
    } else {
      // Multiple requests in step - create group node
      const groupId = randomId();
      nodes[groupId] = {
        id: groupId,
        type: "group",
        label: `Step ${stepIndex}: ${step.length} requests`,
        position: { x: 100, y: stepIndex * 100 },
        parameters: {},
      };

      edgeTo(groupId);

      // Add individual requests as children
      for (let i = 0; i < step.length; i++) {
        const entry = step[i];
        const nodeId = randomId();
        const httpParams = entryToHttpParams(entry);
        
        nodes[nodeId] = {
          id: nodeId,
          type: "http_request",
          label: `${entry.request.method} ${new URL(entry.request.url).pathname}`,
          position: { x: 150, y: stepIndex * 100 + (i + 1) * 50 },
          parameters: httpParams,
          parentId: groupId,
        };
      }

      prevNodeId = groupId;
    }

    prevStepLastEntry = step[step.length - 1];
  }

  const startNode = Object.keys(nodes)[0];

  return {
    graph: {
      nodes,
      edges,
      startNode,
    },
    stats: {
      totalEntries: entries.length,
      importedEntries: filtered.length,
      skippedEntries: skipped,
      steps: steps.length,
    },
    warnings,
  };
}

/**
 * Validate HAR structure
 */
export function validateHar(data: unknown): data is Har {
  if (!data || typeof data !== "object") return false;
  const har = data as Record<string, unknown>;
  
  if (!har.log || typeof har.log !== "object") return false;
  const log = har.log as Record<string, unknown>;
  
  if (!Array.isArray(log.entries)) return false;
  
  return true;
}
