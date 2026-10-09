import { describe, expect, it } from "vitest";
import { errorRateToStored, storedToErrorRate } from "./run-history-metrics";

describe("errorRateToStored", () => {
  it("converts a 0-1 fraction to basis points", () => {
    expect(errorRateToStored(0.055)).toBe(550);
    expect(errorRateToStored(0)).toBe(0);
    expect(errorRateToStored(1)).toBe(10000);
  });

  it("rounds to the nearest basis point", () => {
    expect(errorRateToStored(0.12345)).toBe(1235);
    expect(errorRateToStored(0.00004)).toBe(0);
  });

  it("clamps out-of-range values to 0..10000", () => {
    expect(errorRateToStored(-0.2)).toBe(0);
    expect(errorRateToStored(1.5)).toBe(10000);
  });

  it.each([[NaN], [Infinity], [-Infinity]])("returns undefined for non-finite %s", (input) => {
    expect(errorRateToStored(input)).toBeUndefined();
  });
});

describe("storedToErrorRate", () => {
  it("converts basis points back to a 0-1 fraction", () => {
    expect(storedToErrorRate(550)).toBe(0.055);
    expect(storedToErrorRate(0)).toBe(0);
    expect(storedToErrorRate(10000)).toBe(1);
  });

  it.each([[null], [undefined]])("returns undefined for %s", (input) => {
    expect(storedToErrorRate(input)).toBeUndefined();
  });

  it.each([[0.055], [0], [1]])("round-trips %s", (fraction) => {
    expect(storedToErrorRate(errorRateToStored(fraction))).toBe(fraction);
  });
});
