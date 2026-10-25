import { describe, expect, it } from "vitest";
import {
  calculateThinkTimes,
  classifyNetworkEntry,
  groupBySteps,
  type NDJSONCaptureEvent,
} from "./capture-adapter";

/**
 * Fixtures reproduce the real recorder output: steps and UI events are stamped
 * with wall-clock milliseconds, while CDP network events carry a monotonic
 * clock (seconds since the browser started, multiplied by 1000).
 */
const WALL = 1_792_885_686_547;
const CDP = 339_305_349_278;

const metadata = (): NDJSONCaptureEvent => ({
  type: "metadata",
  data: {
    recordingId: "rec-1",
    startUrl: "https://app.example.com/login",
    viewport: { width: 1280, height: 720 },
    startedAt: WALL,
  },
} as NDJSONCaptureEvent);

const step = (id: string, name: string, timestamp: number): NDJSONCaptureEvent => ({
  type: "step",
  data: { id, name, kind: "auto", timestamp },
} as NDJSONCaptureEvent);

const entry = (id: string, timestamp: number, url = "https://app.example.com/api/session"): NDJSONCaptureEvent => ({
  type: "network_entry",
  data: {
    request: { id, timestamp, method: "GET", url, headers: {}, resourceType: "Fetch" },
    response: { id, timestamp, status: 200, statusText: "OK", headers: {}, mimeType: "application/json", bodySize: 2, bodyTruncated: false },
    timing: { startTime: timestamp, endTime: timestamp + 120, durationMs: 120 },
  },
} as NDJSONCaptureEvent);

describe("groupBySteps", () => {
  it("groups requests by their position in the log even when the clocks disagree", () => {
    const events = [
      metadata(),
      entry("r0", CDP), // page load, before any marker
      step("step-1", "Navigate: login", WALL),
      entry("r1", CDP + 5_000),
      entry("r2", CDP + 6_000),
      step("step-2", "Submit login", WALL + 2_000),
      entry("r3", CDP + 7_000),
    ];

    const groups = groupBySteps(events);

    expect(groups).toHaveLength(2);
    // The requests that precede the first marker belong to the page the user opened.
    expect(groups[0].step.name).toBe("Navigate: login");
    expect(groups[0].entries.map((e) => e.request.id)).toEqual(["r0", "r1", "r2"]);
    expect(groups[1].entries.map((e) => e.request.id)).toEqual(["r3"]);
  });

  it("keeps ui events with the step they follow", () => {
    const ui = (id: string): NDJSONCaptureEvent => ({
      type: "ui_event",
      data: { id, timestamp: WALL + 10, type: "click", selector: "#go", tagName: "BUTTON", attributes: {} },
    } as NDJSONCaptureEvent);

    const groups = groupBySteps([step("step-1", "One", WALL), ui("u1"), step("step-2", "Two", WALL + 100)]);

    expect(groups[0].uiEvents.map((e) => e.id)).toEqual(["u1"]);
    expect(groups[1].uiEvents).toEqual([]);
  });

  it("answers nothing for a capture without steps and without traffic", () => {
    expect(groupBySteps([metadata()])).toEqual([]);
  });
});

describe("calculateThinkTimes", () => {
  it("measures the pause between steps without mixing clocks", () => {
    const groups = groupBySteps([
      step("step-1", "One", WALL),
      // A CDP stamp three days away must not stretch the think time.
      entry("r1", CDP),
      step("step-2", "Two", WALL + 4_000),
    ]);

    const [thinkTime] = calculateThinkTimes(groups);

    expect(thinkTime).toBeCloseTo(4, 5);
  });

  it("uses the request end when it shares the step clock", () => {
    const groups = groupBySteps([
      step("step-1", "One", WALL),
      entry("r1", WALL + 1_000),
      step("step-2", "Two", WALL + 6_000),
    ]);

    const [thinkTime] = calculateThinkTimes(groups);

    // The request ended 1.12s into the step, and the next one started 6s in.
    expect(thinkTime).toBeCloseTo((6_000 - 1_120) / 1000, 5);
  });
});

describe("classifyNetworkEntry", () => {
  it("classifies against the start URL origin", () => {
    const [event] = [entry("r1", WALL)] as [Extract<NDJSONCaptureEvent, { type: "network_entry" }>];

    expect(classifyNetworkEntry(event.data, "https://app.example.com/login")).toBe("core");
    expect(classifyNetworkEntry(event.data, "https://other.example.com/")).toBe("third_party");
  });
});
