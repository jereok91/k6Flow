/**
 * The pure helpers the HAR import screen and its pieces share: form parsing,
 * status badge tones and the immutable selection arithmetic.
 */

import { describe, expect, it } from "vitest";
import { HAR_RESOURCE_TYPES } from "@k6flow/shared";
import {
  addIndexes,
  domainList,
  effectiveStepGapMs,
  optionalNumber,
  removeIndexes,
  resourceTypeList,
  statusTone,
  toggleIn,
  toggleIndex,
} from "./helpers";

describe("HAR import helpers", () => {
  it("reads a status bound only from a real number", () => {
    expect(optionalNumber(" 204 ")).toBe(204);
    expect(optionalNumber("0")).toBe(0);
    expect(optionalNumber("")).toBeUndefined();
    expect(optionalNumber("   ")).toBeUndefined();
    expect(optionalNumber("abc")).toBeUndefined();
  });

  it("splits a domain list on commas, semicolons and whitespace", () => {
    expect(domainList("api.example.com, example.com;other.test\nlast.test")).toEqual([
      "api.example.com",
      "example.com",
      "other.test",
      "last.test",
    ]);
    expect(domainList("   ")).toEqual([]);
  });

  it("treats an empty resource type list as the whole vocabulary", () => {
    expect(resourceTypeList([])).toEqual([...HAR_RESOURCE_TYPES]);
    expect(resourceTypeList(["document"])).toEqual(["document"]);
    expect(HAR_RESOURCE_TYPES.length).toBeGreaterThan(1);
  });

  it("falls back to the default step gap for a negative or unreadable field", () => {
    expect(effectiveStepGapMs("2500", 2000)).toBe(2500);
    expect(effectiveStepGapMs("0", 2000)).toBe(0);
    expect(effectiveStepGapMs("-1", 2000)).toBe(2000);
    expect(effectiveStepGapMs("", 2000)).toBe(2000);
    expect(effectiveStepGapMs("later", 2000)).toBe(2000);
  });

  it("colours a status by the class the table already uses", () => {
    expect(statusTone(200)).toBe("badge-success");
    expect(statusTone(299)).toBe("badge-success");
    expect(statusTone(300)).toBe("badge-warning");
    expect(statusTone(399)).toBe("badge-warning");
    expect(statusTone(400)).toBe("badge-error");
    expect(statusTone(503)).toBe("badge-error");
  });

  it("toggles a value without mutating the list", () => {
    const values = ["a", "b"];

    expect(toggleIn(values, "c")).toEqual(["a", "b", "c"]);
    expect(toggleIn(values, "a")).toEqual(["b"]);
    expect(values).toEqual(["a", "b"]);
  });

  it("keeps the selection immutable while rows are marked", () => {
    const selection: ReadonlySet<number> = new Set([1]);

    expect([...toggleIndex(selection, 2)]).toEqual([1, 2]);
    expect([...toggleIndex(selection, 1)]).toEqual([]);
    expect([...addIndexes(selection, [3, 4])]).toEqual([1, 3, 4]);
    expect([...removeIndexes(selection, [1, 9])]).toEqual([]);
    expect([...selection]).toEqual([1]);
  });
});
