import { describe, expect, it } from "vitest";
import { defaultRecordingName, summarizeCapture } from "./capture-summary";

const CAPTURE = [
  {
    type: "metadata",
    data: {
      recordingId: "rec-1",
      startUrl: "https://shop.example.com/login",
      viewport: { width: 1280, height: 720 },
      startedAt: 1_700_000_000_000,
    },
  },
  {
    type: "network_request",
    data: { id: "r1", timestamp: 1, method: "GET", url: "https://shop.example.com/login", headers: {} },
  },
  {
    type: "network_entry",
    data: {
      request: { id: "r1", timestamp: 1, method: "GET", url: "https://shop.example.com/login", headers: {}, resourceType: "Document" },
      response: { status: 200, headers: {} },
    },
  },
  { type: "step", data: { id: "step-1", name: "Navigate: shop.example.com", kind: "auto", timestamp: 2 } },
  {
    type: "network_entry",
    data: {
      request: { id: "r2", timestamp: 3, method: "POST", url: "https://shop.example.com/api/session", headers: {}, resourceType: "Fetch" },
      response: { status: 201, headers: {} },
    },
  },
  { type: "step", data: { id: "step-2", name: "Submit login", kind: "manual", timestamp: 4 } },
  { type: "end", data: { endedAt: 1_700_000_005_000, reason: "manual" } },
];

const ndjson = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("summarizeCapture", () => {
  it("counts the responses and steps a review screen will list", () => {
    const summary = summarizeCapture(ndjson(CAPTURE));

    // network_request lines are the same request before its response: they are not extra requests.
    expect(summary.requestCount).toBe(2);
    expect(summary.stepCount).toBe(2);
  });

  it("reads the start URL and the recorded duration from the capture itself", () => {
    const summary = summarizeCapture(ndjson(CAPTURE));

    expect(summary.startUrl).toBe("https://shop.example.com/login");
    expect(summary.durationMs).toBe(5_000);
  });

  it("reports the stored byte size of the capture", () => {
    const content = ndjson(CAPTURE);

    expect(summarizeCapture(content).bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("survives a capture without metadata or end marker", () => {
    const summary = summarizeCapture(ndjson([CAPTURE[3], CAPTURE[4]]));

    expect(summary).toMatchObject({ requestCount: 1, stepCount: 1, startUrl: null, durationMs: 0 });
  });

  it("ignores unparsable lines instead of failing the stop", () => {
    const summary = summarizeCapture(`${ndjson(CAPTURE)}\n{not json}\n`);

    expect(summary.requestCount).toBe(2);
  });

  it("reports an empty capture as zero", () => {
    expect(summarizeCapture("")).toMatchObject({ requestCount: 0, stepCount: 0, bytes: 0 });
  });
});

describe("defaultRecordingName", () => {
  it("keeps the name the user typed, trimmed", () => {
    expect(defaultRecordingName("  Flujo de login  ", "https://shop.example.com")).toBe("Flujo de login");
  });

  it("names an unnamed recording after its host and time", () => {
    const name = defaultRecordingName("", "https://shop.example.com/login");

    expect(name).toContain("shop.example.com");
    expect(name).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("still names a recording whose start URL cannot be parsed", () => {
    expect(defaultRecordingName(undefined, "not a url")).toBe("Grabación sin título");
  });
});
