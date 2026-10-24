import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureSize, isValidRecordingId, maxCaptureBytes, readCapture, removeCapture } from "./capture-store";

describe("capture store", () => {
  const dirs: string[] = [];

  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "capture-store-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the capture content of a finished recording", () => {
    const dir = makeDir();
    const content = '{"type":"metadata","data":{}}\n{"type":"end","data":{"reason":"manual"}}\n';
    writeFileSync(join(dir, "rec-1.ndjson"), content);

    expect(readCapture(dir, "rec-1")).toBe(content);
  });

  it("returns null for a recording this process never wrote", () => {
    const dir = makeDir();

    expect(readCapture(dir, "rec-missing")).toBeNull();
  });

  it.each(["", ".", "..", "../main", "rec/../../etc/passwd", "rec 1", "rec-1\n", "/etc/passwd"])(
    "refuses the id %j instead of touching a path outside the capture directory",
    (id) => {
      const dir = makeDir();

      expect(isValidRecordingId(id)).toBe(false);
      expect(readCapture(dir, id)).toBeNull();
    },
  );

  it("accepts the ids the recorder generates", () => {
    expect(isValidRecordingId("rec-1792873238980")).toBe(true);
    expect(isValidRecordingId("probe-1792873873")).toBe(true);
  });

  it("deletes a capture the library already holds", () => {
    const dir = makeDir();
    const path = join(dir, "rec-1.ndjson");
    writeFileSync(path, "{\"type\":\"end\"}\n");

    expect(removeCapture(dir, "rec-1")).toBe(true);
    expect(readCapture(dir, "rec-1")).toBeNull();
  });

  it("reports the size of a capture without reading it", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "rec-1.ndjson"), "0123456789");

    expect(captureSize(dir, "rec-1")).toBe(10);
    expect(captureSize(dir, "rec-missing")).toBeNull();
  });

  it("falls back to the default cap when none is configured", () => {
    expect(maxCaptureBytes(undefined)).toBe(32 * 1024 * 1024);
    expect(maxCaptureBytes("not a number")).toBe(32 * 1024 * 1024);
    expect(maxCaptureBytes("1024")).toBe(1024);
  });

  it("reports a capture that was already gone as not deleted", () => {
    const dir = makeDir();

    expect(removeCapture(dir, "rec-missing")).toBe(false);
    expect(removeCapture(dir, "../main")).toBe(false);
  });
});
