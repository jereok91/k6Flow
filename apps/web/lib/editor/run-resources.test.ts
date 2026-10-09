import { describe, expect, it } from "vitest";
import { computeRunResources } from "./run-resources";

describe("computeRunResources", () => {
  it.each([
    // vus, memoryMiB, cpuMillis
    [1, 256, 750],
    [50, 256, 750],
    [100, 328, 750],
    [500, 1128, 1750],
    [1900, 3928, 4000],
  ])("sizes %i VUs as %i MiB / %i mCPU", (vus, memoryMiB, cpuMillis) => {
    expect(computeRunResources(vus)).toEqual({ memoryMiB, cpuMillis });
  });

  it("keeps the 256 MiB memory floor until 2 MiB/VU overtakes it", () => {
    expect(computeRunResources(64).memoryMiB).toBe(256);
    expect(computeRunResources(65).memoryMiB).toBe(258);
  });

  it("adds a CPU step for each started block of 100 VUs", () => {
    expect(computeRunResources(100).cpuMillis).toBe(750);
    expect(computeRunResources(101).cpuMillis).toBe(1000);
    expect(computeRunResources(200).cpuMillis).toBe(1000);
    expect(computeRunResources(201).cpuMillis).toBe(1250);
  });

  it("caps CPU at 4000 mCPU but never caps memory", () => {
    expect(computeRunResources(1400).cpuMillis).toBe(4000);
    expect(computeRunResources(1401).cpuMillis).toBe(4000);
    expect(computeRunResources(5000)).toEqual({ memoryMiB: 10128, cpuMillis: 4000 });
  });

  it("never goes below the 500 mCPU / 256 MiB floor", () => {
    expect(computeRunResources(0)).toEqual({ memoryMiB: 256, cpuMillis: 500 });
    expect(computeRunResources(-5)).toEqual({ memoryMiB: 256, cpuMillis: 500 });
    expect(computeRunResources(Number.NaN)).toEqual({ memoryMiB: 256, cpuMillis: 500 });
  });

  it("rounds fractional VU counts up and returns integers", () => {
    const result = computeRunResources(100.2);
    expect(result).toEqual({ memoryMiB: 330, cpuMillis: 1000 });
    expect(Number.isInteger(result.memoryMiB)).toBe(true);
    expect(Number.isInteger(result.cpuMillis)).toBe(true);
  });
});
