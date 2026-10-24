/**
 * The wait between two requests is stored on the connection in seconds, but a
 * user thinks in seconds or minutes. Conversion and display live here so the
 * panel stays presentational and the rule is testable without a browser.
 */

import { describe, expect, it } from "vitest";
import { MAX_WAIT_SECONDS, formatWaitLabel, isValidWait, toDisplay, toDisplayInUnit, toSeconds } from "./connection-wait";

describe("toSeconds", () => {
  it("keeps seconds as they are", () => {
    expect(toSeconds(30, "seconds")).toBe(30);
    expect(toSeconds(0, "seconds")).toBe(0);
  });

  it("converts minutes, including fractions", () => {
    expect(toSeconds(1, "minutes")).toBe(60);
    expect(toSeconds(2.5, "minutes")).toBe(150);
    expect(toSeconds(0.5, "minutes")).toBe(30);
  });
});

describe("toDisplay", () => {
  it("shows whole minutes as minutes", () => {
    expect(toDisplay(60)).toEqual({ value: 1, unit: "minutes" });
    expect(toDisplay(3600)).toEqual({ value: 60, unit: "minutes" });
  });

  it("keeps anything else in seconds", () => {
    expect(toDisplay(45)).toEqual({ value: 45, unit: "seconds" });
    expect(toDisplay(90)).toEqual({ value: 90, unit: "seconds" });
    expect(toDisplay(0)).toEqual({ value: 0, unit: "seconds" });
  });
});

describe("formatWaitLabel", () => {
  it("labels a real wait with its unit", () => {
    expect(formatWaitLabel(5)).toBe("5 s");
    expect(formatWaitLabel(120)).toBe("2 min");
    expect(formatWaitLabel(90)).toBe("90 s");
    expect(formatWaitLabel(2.5)).toBe("2.5 s");
  });

  it("labels nothing when there is no wait", () => {
    expect(formatWaitLabel(undefined)).toBeUndefined();
    expect(formatWaitLabel(0)).toBeUndefined();
  });
});

describe("isValidWait", () => {
  it("accepts the bounded range", () => {
    for (const value of [0, 2.5, 60, MAX_WAIT_SECONDS]) expect(isValidWait(value)).toBe(true);
  });

  it("rejects out-of-range and non-finite values", () => {
    for (const value of [-1, MAX_WAIT_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidWait(value)).toBe(false);
    }
  });
});

// Switching the unit must not silently multiply the wait.
describe("toDisplayInUnit", () => {
  it("keeps the total when converting to minutes", () => {
    expect(toDisplayInUnit(300, "minutes")).toBe("5");
    expect(toDisplayInUnit(90, "minutes")).toBe("1.5");
    expect(toDisplayInUnit(3600, "minutes")).toBe("60");
  });

  it("keeps the total when staying in seconds", () => {
    expect(toDisplayInUnit(90, "seconds")).toBe("90");
    expect(toDisplayInUnit(0, "seconds")).toBe("0");
  });

  it("rounds a fractional minute instead of losing the value", () => {
    expect(toDisplayInUnit(5, "minutes")).toBe("0.0833");
  });
});
