/**
 * The request body of `POST /api/import/har`: only the filters that actually
 * narrow an already pruned HAR are sent, so the server options stay inert.
 */

import { describe, expect, it } from "vitest";
import { HAR_RESOURCE_TYPES } from "@k6flow/shared";
import { EMPTY_FILTERS } from "./types";
import type { FilterState } from "./types";
import { buildImportOptions } from "./preview";

const filters = (overrides: Partial<FilterState> = {}): FilterState => ({
  ...EMPTY_FILTERS,
  ...overrides,
});

const options = (overrides: Partial<Parameters<typeof buildImportOptions>[0]> = {}) =>
  buildImportOptions({
    filters: filters(),
    activeResourceTypes: [...HAR_RESOURCE_TYPES],
    activeMethods: ["GET", "POST"],
    methodOptions: ["GET", "POST"],
    stepGapMs: 2000,
    useHarTimings: true,
    ...overrides,
  });

describe("HAR import options", () => {
  it("omits every narrowing filter when nothing was narrowed", () => {
    const body = options();

    expect(body).toEqual({
      excludeStatic: false,
      mainDocumentsOnly: false,
      stepGapMs: 2000,
      useHarTimings: true,
    });
    expect("includeResourceTypes" in body).toBe(false);
    expect("methods" in body).toBe(false);
  });

  it("sends the resource types and methods the user narrowed to", () => {
    const body = options({
      activeResourceTypes: ["document"],
      activeMethods: ["GET"],
    });

    expect(body.includeResourceTypes).toEqual(["document"]);
    expect(body.methods).toEqual(["GET"]);
  });

  it("sends status bounds and domains only when the fields have content", () => {
    expect(options({ filters: filters({ statusMin: "200", statusMax: "299" }) })).toMatchObject({
      statusMin: 200,
      statusMax: 299,
    });
    expect(
      options({
        filters: filters({
          includeDomains: "api.example.com, example.com",
          excludeDomains: "sentry.io",
        }),
      }),
    ).toMatchObject({
      includeDomains: ["api.example.com", "example.com"],
      excludeDomains: ["sentry.io"],
    });
    expect(options({ filters: filters({ statusMin: "nope", includeDomains: " , " }) })).toEqual({
      excludeStatic: false,
      mainDocumentsOnly: false,
      stepGapMs: 2000,
      useHarTimings: true,
    });
  });

  it("carries the timings the form chose", () => {
    const body = options({ stepGapMs: 0, useHarTimings: false });

    expect(body.stepGapMs).toBe(0);
    expect(body.useHarTimings).toBe(false);
  });
});
