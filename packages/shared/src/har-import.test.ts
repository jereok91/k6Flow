import { describe, expect, it } from "vitest";
import {
  HAR_RESOURCE_TYPES,
  classifyHarEntry,
  importHar,
  isHarResourceType,
  validateHar,
} from "./har-import";
import type { Har, HarEntry, HarImportOptions, HarImportResult } from "./har-import";
import {
  HAR_RESOURCE_TYPES as PUBLIC_RESOURCE_TYPES,
  classifyHarEntry as publicClassifyHarEntry,
  isHarResourceType as publicIsHarResourceType,
} from "./index";

const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

interface EntrySpec {
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  resourceType?: string;
  startedDateTime?: string;
  time?: number;
}

function entry(spec: EntrySpec = {}): HarEntry {
  const harEntry: HarEntry = {
    startedDateTime: spec.startedDateTime ?? "2026-01-01T00:00:00.000Z",
    time: spec.time ?? 100,
    request: {
      method: spec.method ?? "GET",
      url: spec.url ?? "https://api.example.com/api/data",
      httpVersion: "http/2",
      headers: [],
      queryString: [],
      headersSize: 0,
      bodySize: 0,
    },
    response: {
      status: spec.status ?? 200,
      statusText: "OK",
      httpVersion: "http/2",
      headers: [],
      content: { size: 1, mimeType: spec.mimeType ?? "application/json" },
      redirectURL: "",
      headersSize: 0,
      bodySize: 1,
    },
    cache: {},
    timings: { send: 0, wait: spec.time ?? 100, receive: 0 },
  };
  if (spec.resourceType !== undefined) harEntry._resourceType = spec.resourceType;
  return harEntry;
}

function har(entries: HarEntry[]): Har {
  return { log: { version: "1.2", creator: { name: "test", version: "1" }, entries } };
}

const options = (overrides: Partial<HarImportOptions> = {}): HarImportOptions => ({
  name: "Scenario",
  ...overrides,
});

const importedUrls = (result: HarImportResult): string[] =>
  Object.values(result.graph.nodes)
    .filter((node) => node.type === "http_request")
    .map((node) => node.parameters.url ?? "");

const expectTruthfulStats = (result: HarImportResult, total: number): void => {
  expect(result.stats.totalEntries).toBe(total);
  expect(result.stats.importedEntries + result.stats.skippedEntries).toBe(total);
};

const waits = (result: HarImportResult): Array<number | undefined> =>
  result.graph.edges.map((edge) => edge.waitSeconds);

// -----------------------------------------------------------------------------
// Resource type classification (D2)
// -----------------------------------------------------------------------------

describe("classifyHarEntry", () => {
  it("classifies a document from the response mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "text/html; charset=utf-8" }))).toBe("document");
  });

  it("classifies an xhr from a JSON mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "application/json" }))).toBe("xhr");
  });

  it("classifies a script from a JavaScript mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "text/javascript" }))).toBe("script");
  });

  it("classifies a stylesheet from a CSS mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "text/css" }))).toBe("stylesheet");
  });

  it("classifies an image from an image mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "image/png" }))).toBe("image");
  });

  it("classifies a font from a font mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "font/woff2" }))).toBe("font");
  });

  it("classifies media from an audio or video mime type", () => {
    expect(classifyHarEntry(entry({ mimeType: "video/mp4" }))).toBe("media");
    expect(classifyHarEntry(entry({ mimeType: "audio/mpeg" }))).toBe("media");
  });

  it("classifies a websocket from a ws url", () => {
    expect(classifyHarEntry(entry({ url: "wss://api.example.com/socket", mimeType: "" }))).toBe("websocket");
  });

  it("classifies a fetch from the DevTools resource type", () => {
    expect(classifyHarEntry(entry({ resourceType: "fetch", mimeType: "application/json" }))).toBe("fetch");
  });

  it("prefers _resourceType over the response mime type", () => {
    expect(classifyHarEntry(entry({ resourceType: "Fetch", mimeType: "text/html" }))).toBe("fetch");
    expect(classifyHarEntry(entry({ resourceType: "Document", mimeType: "application/json" }))).toBe("document");
  });

  it("classifies an unknown mime type as other", () => {
    expect(classifyHarEntry(entry({ mimeType: "application/octet-stream" }))).toBe("other");
  });

  it("falls back to the mime type when _resourceType is not a known DevTools type", () => {
    expect(classifyHarEntry(entry({ resourceType: "beacon", mimeType: "text/css" }))).toBe("stylesheet");
  });

  it("classifies a wholly unknown entry as other", () => {
    expect(classifyHarEntry(entry({ resourceType: "beacon", mimeType: "application/octet-stream" }))).toBe("other");
  });

  it("exposes the DevTools resource type vocabulary", () => {
    expect([...HAR_RESOURCE_TYPES]).toEqual([
      "document", "xhr", "fetch", "script", "stylesheet",
      "image", "font", "media", "websocket", "other",
    ]);
    expect(isHarResourceType("fetch")).toBe(true);
    expect(isHarResourceType("beacon")).toBe(false);
    expect(isHarResourceType(undefined)).toBe(false);
  });

  it("is re-exported from the package entry point", () => {
    expect(publicClassifyHarEntry).toBe(classifyHarEntry);
    expect(publicIsHarResourceType).toBe(isHarResourceType);
    expect(PUBLIC_RESOURCE_TYPES).toBe(HAR_RESOURCE_TYPES);
  });
});

// -----------------------------------------------------------------------------
// Filters (D1 / S2)
// -----------------------------------------------------------------------------

const mixedEntries = (): HarEntry[] => [
  entry({ url: "https://app.example.com/overview", mimeType: "text/html", startedDateTime: "2026-01-01T00:00:00.000Z" }),
  entry({ url: "https://api.example.com/v1/status", mimeType: "application/json", startedDateTime: "2026-01-01T00:00:01.000Z" }),
  entry({ url: "https://api.example.com/v1/login", method: "POST", status: 201, startedDateTime: "2026-01-01T00:00:02.000Z" }),
  entry({ url: "https://cdn.example.com/app.css", mimeType: "text/css", startedDateTime: "2026-01-01T00:00:03.000Z" }),
  entry({ url: "https://cdn.assets.net/logo.png", mimeType: "image/png", status: 404, startedDateTime: "2026-01-01T00:00:04.000Z" }),
];

describe("importHar filters", () => {
  it("keeps every entry when no filter is given", () => {
    const result = importHar(har(mixedEntries()), options());

    expect(result.stats.importedEntries).toBe(5);
    expect(result.stats.skippedEntries).toBe(0);
    expectTruthfulStats(result, 5);
  });

  it("keeps only the included resource types", () => {
    const result = importHar(har(mixedEntries()), options({ includeResourceTypes: ["xhr"] }));

    expect(importedUrls(result)).toEqual([
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/login",
    ]);
    expectTruthfulStats(result, 5);
    expect(result.stats.importedEntries).toBe(2);
    expect(result.stats.skippedEntries).toBe(3);
  });

  it("drops the excluded resource types", () => {
    const result = importHar(har(mixedEntries()), options({ excludeResourceTypes: ["image", "stylesheet"] }));

    expect(importedUrls(result)).toEqual([
      "https://app.example.com/overview",
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/login",
    ]);
    expectTruthfulStats(result, 5);
  });

  it("keeps only the allowed methods, case-insensitively", () => {
    const result = importHar(har(mixedEntries()), options({ methods: ["post"] }));

    expect(importedUrls(result)).toEqual(["https://api.example.com/v1/login"]);
    expectTruthfulStats(result, 5);
  });

  it("keeps only the inclusive status range", () => {
    const result = importHar(har(mixedEntries()), options({ statusMin: 201, statusMax: 201 }));

    expect(importedUrls(result)).toEqual(["https://api.example.com/v1/login"]);
    expectTruthfulStats(result, 5);

    const broad = importHar(har(mixedEntries()), options({ statusMin: 200, statusMax: 299 }));
    expect(broad.stats.importedEntries).toBe(4);
    expect(importedUrls(broad)).not.toContain("https://cdn.assets.net/logo.png");
  });

  it("restricts imports to the allowed domains, including their subdomains", () => {
    const result = importHar(har(mixedEntries()), options({ includeDomains: ["api.example.com"] }));

    expect(importedUrls(result)).toEqual([
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/login",
    ]);
    expectTruthfulStats(result, 5);
  });

  it("removes the denied domains", () => {
    const result = importHar(har(mixedEntries()), options({ excludeDomains: ["assets.net"] }));

    expect(importedUrls(result)).not.toContain("https://cdn.assets.net/logo.png");
    expect(result.stats.importedEntries).toBe(4);
    expectTruthfulStats(result, 5);
  });

  it("combines filters with OR inside a kind and AND across kinds", () => {
    const result = importHar(har(mixedEntries()), options({
      includeResourceTypes: ["xhr", "document"],
      methods: ["get"],
      statusMin: 200,
      statusMax: 299,
      excludeDomains: ["assets.net"],
    }));

    expect(importedUrls(result)).toEqual([
      "https://app.example.com/overview",
      "https://api.example.com/v1/status",
    ]);
    expectTruthfulStats(result, 5);
  });

  it("treats an empty filter list as no constraint", () => {
    const result = importHar(har(mixedEntries()), options({ includeResourceTypes: [], methods: [] }));

    expect(result.stats.importedEntries).toBe(5);
    expectTruthfulStats(result, 5);
  });

  it("keeps the legacy urlFilter, excludeStatic, mainDocumentsOnly and stepGapMs behaviour", () => {
    const result = importHar(har(mixedEntries()), options({
      urlFilter: /api\.example\.com/,
      excludeStatic: true,
      mainDocumentsOnly: false,
      stepGapMs: 500,
    }));

    expect(importedUrls(result)).toEqual([
      "https://api.example.com/v1/status",
      "https://api.example.com/v1/login",
    ]);
    expectTruthfulStats(result, 5);

    const documents = importHar(har(mixedEntries()), options({ mainDocumentsOnly: true }));
    expect(importedUrls(documents)).toEqual(["https://app.example.com/overview"]);
  });

  it("reports no entries when filters match nothing", () => {
    const result = importHar(har(mixedEntries()), options({ methods: ["DELETE"] }));

    expect(result.stats.importedEntries).toBe(0);
    expect(result.stats.skippedEntries).toBe(5);
    expect(result.warnings).toContain("No entries matched import filters");
  });
});

// -----------------------------------------------------------------------------
// Timings (D3 / S3)
// -----------------------------------------------------------------------------

describe("importHar connection timings", () => {
  it("writes the gap between consecutive entries as waitSeconds in seconds", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/first", startedDateTime: "2026-01-01T00:00:00.000Z", time: 500 }),
      entry({ url: "https://api.example.com/second", startedDateTime: "2026-01-01T00:00:03.000Z", time: 250 }),
    ]), options());

    expect(result.graph.edges).toHaveLength(1);
    // 3.000s - (0.000s + 0.500s) = 2.5s
    expect(result.graph.edges[0].waitSeconds).toBe(2.5);
  });

  it("writes a zero wait when the next request starts exactly when the previous one ended", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/first", startedDateTime: "2026-01-01T00:00:00.000Z", time: 500 }),
      entry({ url: "https://api.example.com/second", startedDateTime: "2026-01-01T00:00:00.500Z", time: 100 }),
    ]), options({ stepGapMs: 100 }));

    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].waitSeconds).toBe(0);
  });

  it("clamps a negative gap to zero", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/first", startedDateTime: "2026-01-01T00:00:00.000Z", time: 9000 }),
      entry({ url: "https://api.example.com/second", startedDateTime: "2026-01-01T00:00:00.001Z", time: 100 }),
    ]), options({ stepGapMs: 0 }));

    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].waitSeconds).toBe(0);
  });

  it("clamps a gap above one hour to 3600 seconds", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/first", startedDateTime: "2026-01-01T00:00:00.000Z", time: 100 }),
      entry({ url: "https://api.example.com/second", startedDateTime: "2026-01-01T08:00:00.000Z", time: 100 }),
    ]), options());

    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].waitSeconds).toBe(3600);
  });

  it("omits waitSeconds when useHarTimings is false", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/first", startedDateTime: "2026-01-01T00:00:00.000Z", time: 500 }),
      entry({ url: "https://api.example.com/second", startedDateTime: "2026-01-01T00:00:03.000Z", time: 250 }),
    ]), options({ useHarTimings: false }));

    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].waitSeconds).toBeUndefined();
    expect(waits(result)).toEqual([undefined]);
  });

  it("writes one wait per step boundary and never on the first step", () => {
    const result = importHar(har([
      entry({ url: "https://api.example.com/a", startedDateTime: "2026-01-01T00:00:00.000Z", time: 100 }),
      entry({ url: "https://api.example.com/b", startedDateTime: "2026-01-01T00:00:05.000Z", time: 100 }),
      entry({ url: "https://api.example.com/c", startedDateTime: "2026-01-01T00:00:10.000Z", time: 100 }),
    ]), options());

    expect(result.stats.steps).toBe(3);
    expect(waits(result)).toEqual([4.9, 4.9]);
  });
});

// -----------------------------------------------------------------------------
// Acceptance: the reference HAR from docs/examploHar.har
// -----------------------------------------------------------------------------

// The reference HAR is the user's own export and is not versioned, so this
// acceptance block only runs where the file exists instead of failing CI with
// ENOENT.
const hasReferenceHar = (() => {
  try {
    readFileSync("docs/examploHar.har", "utf8");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasReferenceHar)("importHar acceptance on docs/examploHar.har", () => {
  const loadReferenceHar = (): Har => {
    const parsed: unknown = JSON.parse(readFileSync("docs/examploHar.har", "utf8"));
    expect(validateHar(parsed)).toBe(true);
    return parsed as Har;
  };

  it("imports the reference HAR without throwing and derives bounded waits", () => {
    const reference = loadReferenceHar();
    expect(reference.log.entries).toHaveLength(16);

    const result = importHar(reference, options({ name: "Reference", excludeStatic: false }));

    expect(result.stats.totalEntries).toBe(16);
    expect(result.stats.importedEntries).toBe(16);
    expect(result.stats.skippedEntries).toBe(0);
    expectTruthfulStats(result, 16);
    expect(result.stats.steps).toBeGreaterThan(0);

    const withWait = result.graph.edges.filter((edge) => typeof edge.waitSeconds === "number");
    expect(withWait.length).toBeGreaterThan(0);
    for (const edge of result.graph.edges) {
      if (edge.waitSeconds === undefined) continue;
      expect(edge.waitSeconds).toBeGreaterThanOrEqual(0);
      expect(edge.waitSeconds).toBeLessThanOrEqual(3600);
    }
    expect(result.graph.edges.length).toBe(result.stats.steps - 1);

    // Every entry in the reference file is a fetch, and the classifier agrees.
    const fetches = importHar(reference, options({ includeResourceTypes: ["fetch"], excludeStatic: false }));
    expect(fetches.stats.importedEntries).toBe(16);
    const xhrs = importHar(reference, options({ includeResourceTypes: ["xhr"], excludeStatic: false }));
    expect(xhrs.stats.importedEntries).toBe(0);
    expect(xhrs.stats.skippedEntries).toBe(16);
  });
});
