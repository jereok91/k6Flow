import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
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

/** Largest capture the recorder will read and serve, unless configured otherwise. */
export const DEFAULT_MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export function maxCaptureBytes(configured: string | undefined): number {
  const value = Number.parseInt(configured ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CAPTURE_BYTES;
}

/**
 * Size of a capture file in bytes, or null when the id is invalid or nothing was
 * written for it. Checked before reading, so an oversized file never has to be
 * buffered to be refused.
 */
export function captureSize(dir: string, recordingId: string): number | null {
  const path = capturePath(dir, recordingId);
  if (path === null || !existsSync(path)) return null;
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch (error) {
    console.error("[capture-store] Stat failed:", error);
    return null;
  }
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

/**
 * Delete a finished capture once the library holds it. Returns false when there
 * was nothing to delete, so the caller can answer honestly.
 */
export function removeCapture(dir: string, recordingId: string): boolean {
  const path = capturePath(dir, recordingId);
  if (path === null || !existsSync(path)) return false;
  try {
    rmSync(path);
    return true;
  } catch (error) {
    console.error("[capture-store] Delete failed:", error);
    return false;
  }
}
