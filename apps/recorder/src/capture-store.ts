import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recording ids that may be resolved to a capture file.
 *
 * The id arrives from an HTTP path, so it is validated as a single path segment
 * before it ever reaches `join`: no separators, no leading dot, no empty value.
 */
const RECORDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidRecordingId(recordingId: string): boolean {
  return RECORDING_ID_PATTERN.test(recordingId);
}

/**
 * Absolute path of a recording's capture file, or null when the id is not a
 * single safe path segment.
 */
export function capturePath(dir: string, recordingId: string): string | null {
  if (!isValidRecordingId(recordingId)) return null;
  return join(dir, `${recordingId}.ndjson`);
}

/**
 * Read a finished capture as NDJSON text. Returns null when the id is invalid or
 * no capture was written for it.
 */
export function readCapture(dir: string, recordingId: string): string | null {
  const path = capturePath(dir, recordingId);
  if (path === null || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // A permission error, a directory at the capture path, or a race with a
    // rewrite is an unreadable capture, not a reason to fail the request.
    console.error("[capture-store] Read failed:", error);
    return null;
  }
}
