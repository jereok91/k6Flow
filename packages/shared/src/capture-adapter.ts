/**
 * Adapter to convert new recorder NDJSON format for processing.
 */

/**
 * Network entry from new recorder format (NDJSON).
 */
export interface NDJSONNetworkEntry {
  type: "network_entry";
  data: {
    request: {
      id: string;
      timestamp: number;
      method: string;
      url: string;
      headers: Record<string, string>;
      postData?: string;
      resourceType: string;
    };
    response?: {
      id: string;
      timestamp: number;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      mimeType: string;
      bodySize: number;
      body?: string;
      bodyTruncated: boolean;
    };
    timing?: {
      startTime: number;
      endTime: number;
      durationMs: number;
    };
  };
}

/**
 * UI event from new recorder format (NDJSON).
 */
export interface NDJSONUIEvent {
  type: "ui_event";
  data: {
    id: string;
    timestamp: number;
    type: "click" | "input" | "change" | "submit" | "focus" | "blur" | "scroll" | "keydown";
    selector: string;
    tagName: string;
    attributes: Record<string, string>;
    value?: string;
    text?: string;
    position?: { x: number; y: number };
    key?: string;
  };
}

/**
 * Step from new recorder format (NDJSON).
 */
export interface NDJSONStep {
  type: "step";
  data: {
    id: string;
    name: string;
    kind: "step" | "assert" | "note" | "auto";
    timestamp: number;
    note?: string;
    trigger?: string;
  };
}

/**
 * Metadata from new recorder format (NDJSON).
 */
export interface NDJSONMetadata {
  type: "metadata";
  data: {
    recordingId: string;
    startUrl: string;
    viewport: { width: number; height: number };
    startedAt: number;
    userAgent?: string;
  };
}

/**
 * Any event from the NDJSON capture file.
 */
export type NDJSONCaptureEvent =
  | NDJSONMetadata
  | NDJSONNetworkEntry
  | NDJSONUIEvent
  | NDJSONStep
  | { type: "navigation"; data: { url: string; title: string; timestamp: number } }
  | { type: "state_change"; data: { state: string; timestamp: number } }
  | { type: "end"; data: { endedAt: number; reason: string } }
  | { type: "network_request"; data: any }; // Intermediate request before response

/**
 * Parse NDJSON capture file content.
 */
export function parseNDJSONCapture(content: string): NDJSONCaptureEvent[] {
  const events: NDJSONCaptureEvent[] = [];
  const lines = content.trim().split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      console.warn("Failed to parse NDJSON line:", line);
    }
  }

  return events;
}

/**
 * Extract metadata from capture events.
 */
export function extractMetadata(events: NDJSONCaptureEvent[]): NDJSONMetadata["data"] | null {
  const meta = events.find((e) => e.type === "metadata") as NDJSONMetadata | undefined;
  return meta?.data ?? null;
}

/**
 * Extract network entries from capture events.
 */
export function extractNetworkEntries(events: NDJSONCaptureEvent[]): NDJSONNetworkEntry["data"][] {
  return events
    .filter((e): e is NDJSONNetworkEntry => e.type === "network_entry")
    .map((e) => e.data);
}

/**
 * Extract UI events from capture events.
 */
export function extractUIEvents(events: NDJSONCaptureEvent[]): NDJSONUIEvent["data"][] {
  return events
    .filter((e): e is NDJSONUIEvent => e.type === "ui_event")
    .map((e) => e.data);
}

/**
 * Extract steps from capture events.
 */
export function extractSteps(events: NDJSONCaptureEvent[]): NDJSONStep["data"][] {
  return events
    .filter((e): e is NDJSONStep => e.type === "step")
    .map((e) => e.data);
}

/**
 * Normalized capture entry for graph generation.
 */
export interface NormalizedCaptureEntry {
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Array<{ name: string; value: string }>;
  responseBody?: string;
  durationMs: number;
  resourceType: string;
}

/**
 * Convert NDJSON network entry to normalized format.
 */
export function normalizeNetworkEntry(entry: NDJSONNetworkEntry["data"]): NormalizedCaptureEntry {
  const { request, response, timing } = entry;

  return {
    timestamp: request.timestamp,
    method: request.method,
    url: request.url,
    requestHeaders: Object.entries(request.headers).map(([name, value]) => ({ name, value })),
    requestBody: request.postData,
    responseStatus: response?.status ?? 0,
    responseHeaders: response ? Object.entries(response.headers).map(([name, value]) => ({ name, value })) : [],
    responseBody: response?.body,
    durationMs: timing?.durationMs ?? 0,
    resourceType: request.resourceType,
  };
}

/**
 * Convert all network entries from NDJSON to normalized format.
 */
export function normalizeNetworkEntries(events: NDJSONCaptureEvent[]): NormalizedCaptureEntry[] {
  const networkEntries = extractNetworkEntries(events);
  return networkEntries.map(normalizeNetworkEntry);
}

/**
 * Classify a network entry as core, static, third_party, analytics, or noise.
 */
export function classifyNetworkEntry(
  entry: NDJSONNetworkEntry["data"],
  startUrl: string
): "core" | "static" | "third_party" | "analytics" | "noise" {
  const url = new URL(entry.request.url);
  const startUrlObj = new URL(startUrl);

  // Same origin?
  const sameOrigin = url.origin === startUrlObj.origin;

  // Static resource types
  const staticTypes = ["Image", "Stylesheet", "Font", "Media"];
  if (staticTypes.includes(entry.request.resourceType)) {
    return "static";
  }

  // Analytics domains
  const analyticsDomains = [
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.net",
    "doubleclick.net",
    "hotjar.com",
    "mixpanel.com",
    "segment.com",
    "amplitude.com",
  ];
  if (analyticsDomains.some((d) => url.hostname.includes(d))) {
    return "analytics";
  }

  // Third party
  if (!sameOrigin) {
    return "third_party";
  }

  // Noise patterns
  const noisePaths = ["/favicon.ico", "/robots.txt", "/.well-known/"];
  if (noisePaths.some((p) => url.pathname.startsWith(p))) {
    return "noise";
  }

  // Core by default for same-origin
  return "core";
}

/**
 * Group network entries by step.
 */
export interface StepGroup {
  step: NDJSONStep["data"];
  entries: NDJSONNetworkEntry["data"][];
  uiEvents: NDJSONUIEvent["data"][];
}

export function groupBySteps(events: NDJSONCaptureEvent[]): StepGroup[] {
  const steps = extractSteps(events);
  const entries = extractNetworkEntries(events);
  const uiEvents = extractUIEvents(events);

  // Sort everything by timestamp
  const allEvents = [
    ...steps.map((s) => ({ ...s, _type: "step" as const })),
    ...entries.map((e) => ({ ...e, _type: "entry" as const, timestamp: e.request.timestamp })),
    ...uiEvents.map((u) => ({ ...u, _type: "ui" as const })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const groups: StepGroup[] = [];
  let currentStep: NDJSONStep["data"] | null = null;
  let currentEntries: NDJSONNetworkEntry["data"][] = [];
  let currentUIEvents: NDJSONUIEvent["data"][] = [];

  for (const event of allEvents) {
    if (event._type === "step") {
      // Save previous group
      if (currentStep) {
        groups.push({
          step: currentStep,
          entries: currentEntries,
          uiEvents: currentUIEvents,
        });
      }
      currentStep = event as unknown as NDJSONStep["data"];
      currentEntries = [];
      currentUIEvents = [];
    } else if (event._type === "entry") {
      currentEntries.push(event as unknown as NDJSONNetworkEntry["data"]);
    } else if (event._type === "ui") {
      currentUIEvents.push(event as unknown as NDJSONUIEvent["data"]);
    }
  }

  // Don't forget the last group
  if (currentStep) {
    groups.push({
      step: currentStep,
      entries: currentEntries,
      uiEvents: currentUIEvents,
    });
  }

  return groups;
}

/**
 * Calculate think time between steps (in seconds).
 */
export function calculateThinkTimes(groups: StepGroup[]): number[] {
  const thinkTimes: number[] = [];

  for (let i = 1; i < groups.length; i++) {
    const prevEnd = Math.max(
      groups[i - 1].step.timestamp,
      ...groups[i - 1].entries.map((e) => e.timing?.endTime ?? e.request.timestamp)
    );
    const currStart = groups[i].step.timestamp;
    const thinkTimeMs = currStart - prevEnd;
    thinkTimes.push(Math.max(0, thinkTimeMs / 1000)); // Convert to seconds
  }

  return thinkTimes;
}
