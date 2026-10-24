/**
 * Summary of a raw NDJSON capture, computed from the capture itself so the
 * recordings library never has to trust numbers sent by the browser.
 */

import {
  extractMetadata,
  extractNetworkEntries,
  extractSteps,
  parseNDJSONCapture,
} from "@k6flow/shared";

export interface CaptureSummary {
  requestCount: number;
  stepCount: number;
  durationMs: number;
  startUrl: string | null;
  /** When the recording began, from the capture itself. */
  startedAt: number | null;
  /**
   * True only when the capture carries its end marker. A crash or a failed flush
   * leaves a file that is readable but incomplete, and it must not be stored as
   * a completed recording.
   */
  complete: boolean;
  bytes: number;
}

export function summarizeCapture(content: string): CaptureSummary {
  const events = parseNDJSONCapture(content);
  const metadata = extractMetadata(events);
  const endEvent = events.find((event) => event.type === "end");

  return {
    // network_request lines are the same exchange before its response arrives.
    requestCount: extractNetworkEntries(events).length,
    stepCount: extractSteps(events).length,
    durationMs:
      metadata && endEvent && endEvent.type === "end"
        ? Math.max(0, endEvent.data.endedAt - metadata.startedAt)
        : 0,
    startUrl: metadata?.startUrl ?? null,
    startedAt: metadata?.startedAt ?? null,
    complete: endEvent !== undefined,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * Display name for a recording: what the user typed, or a stable fallback built
 * from the start host and the time the recording began.
 */
export function defaultRecordingName(
  name: string | undefined,
  startUrl: string | undefined,
  startedAt?: number | null,
): string {
  const typed = typeof name === "string" ? name.trim() : "";
  if (typed !== "") return typed;

  let host: string | null = null;
  try {
    host = startUrl ? new URL(startUrl).hostname : null;
  } catch {
    host = null;
  }
  if (host === null || host === "") return "Grabación sin título";

  const when = new Date(startedAt ?? Date.now());
  const stamp = when.toISOString().slice(0, 16).replace("T", " ");
  return `Grabación ${host} ${stamp}`;
}
