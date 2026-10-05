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
  edges: Array<{ from: string; to: string }>;
  startNode?: string;
}

// HAR 1.2 types (simplified)
export interface HarEntry {
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
  let prevNodeId: string | undefined;
  let stepIndex = 0;

  for (const step of steps) {
    stepIndex++;
    
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

      if (prevNodeId) {
        edges.push({ from: prevNodeId, to: nodeId });
      }
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

      if (prevNodeId) {
        edges.push({ from: prevNodeId, to: groupId });
      }

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
