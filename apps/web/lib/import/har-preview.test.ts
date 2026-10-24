import { describe, expect, it } from "vitest";
import {
  harGraphToComposition,
  importHar,
  suggestHarVariables,
} from "@k6flow/shared";
import type { Har, HarEntry } from "@k6flow/shared";
import {
  availableMethods,
  availableResourceTypes,
  filterPreviewEntries,
  harEntries,
  pruneHar,
  summarize,
} from "./har-preview";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const START = "2026-01-01T00:00:00.000Z";

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
    startedDateTime: spec.startedDateTime ?? START,
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

/**
 * A HAR shaped like a browser export: DevTools `_resourceType` on some entries,
 * only a mime type on others, two origins, four methods and a spread of statuses.
 */
function sourceHar(): Har {
  return {
    log: {
      version: "1.2",
      creator: { name: "DevTools", version: "141.0" },
      pages: [{ startedDateTime: START, id: "page_1", title: "Example" }],
      entries: [
        entry({
          url: "https://app.example.com/index.html",
          resourceType: "Document",
          mimeType: "text/html",
          status: 200,
          time: 120,
          startedDateTime: "2026-01-01T00:00:00.000Z",
        }),
        entry({
          url: "https://api.example.com/v1/items?page=2",
          resourceType: "XHR",
          method: "get",
          status: 201,
          time: 45,
          startedDateTime: "2026-01-01T00:00:01.000Z",
        }),
        entry({
          url: "https://api.example.com/v1/items",
          method: "POST",
          mimeType: "application/json",
          status: 500,
          time: 310,
          startedDateTime: "2026-01-01T00:00:02.000Z",
        }),
        entry({
          url: "https://cdn.example.com/logo.png",
          resourceType: "Image",
          status: 304,
          time: 12,
          startedDateTime: "2026-01-01T00:00:03.000Z",
        }),
        entry({
          url: "https://other.test/track",
          resourceType: "Fetch",
          method: "PUT",
          status: 404,
          time: 7,
          startedDateTime: "2026-01-01T00:00:04.000Z",
        }),
      ],
    },
  };
}

const urls = (entries: ReadonlyArray<{ url: string }>): string[] => entries.map((e) => e.url);

/** Request URLs of a HAR's entries, in order. */
const entryUrls = (har: Har): string[] => har.log.entries.map((e) => e.request.url);

const indexesOf = (entries: ReadonlyArray<{ index: number }>): number[] =>
  entries.map((e) => e.index);

// -----------------------------------------------------------------------------
// harEntries
// -----------------------------------------------------------------------------

describe("harEntries", () => {
  it("returns one ordered row per HAR entry with an original index", () => {
    const rows = harEntries(sourceHar());

    expect(indexesOf(rows)).toEqual([0, 1, 2, 3, 4]);
    expect(urls(rows)[0]).toBe("https://app.example.com/index.html");
  });

  it("splits the URL into origin and path", () => {
    const rows = harEntries(sourceHar());

    expect(rows[1].origin).toBe("https://api.example.com");
    expect(rows[1].path).toBe("/v1/items");
  });

  it("classifies the resource type the way the shared importer does", () => {
    const rows = harEntries(sourceHar());

    // DevTools name wins; without one the response mime type decides.
    expect(rows.map((row) => row.resourceType)).toEqual([
      "document",
      "xhr",
      "xhr",
      "image",
      "fetch",
    ]);
  });

  it("keeps the method upper-cased and the status, duration and start time", () => {
    const rows = harEntries(sourceHar());

    expect(rows[1].method).toBe("GET");
    expect(rows[1].status).toBe(201);
    expect(rows[1].durationMs).toBe(45);
    expect(rows[1].startedDateTime).toBe("2026-01-01T00:00:01.000Z");
  });

  it("survives an unparseable URL instead of throwing", () => {
    const rows = harEntries({ log: { ...sourceHar().log, entries: [entry({ url: "not a url" })] } });

    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("");
    expect(rows[0].path).toBe("not a url");
  });

  it("returns nothing for a HAR with no entries", () => {
    const rows = harEntries({ log: { ...sourceHar().log, entries: [] } });

    expect(rows).toEqual([]);
    expect(filterPreviewEntries(rows, { text: "api" })).toEqual([]);
    expect(summarize(rows, new Set())).toEqual({
      total: 0,
      kept: 0,
      dropped: 0,
      byResourceType: {},
      byMethod: {},
      origins: [],
    });
  });
});

// -----------------------------------------------------------------------------
// filterPreviewEntries
// -----------------------------------------------------------------------------

describe("filterPreviewEntries", () => {
  const rows = harEntries(sourceHar());

  it("treats an empty filter set as no restriction", () => {
    expect(indexesOf(filterPreviewEntries(rows))).toEqual([0, 1, 2, 3, 4]);
    expect(indexesOf(filterPreviewEntries(rows, {}))).toEqual([0, 1, 2, 3, 4]);
    expect(indexesOf(filterPreviewEntries(rows, {
      resourceTypes: [],
      methods: [],
      includeDomains: [],
      excludeDomains: [],
      text: "   ",
    }))).toEqual([0, 1, 2, 3, 4]);
  });

  it("filters by resource type", () => {
    expect(indexesOf(filterPreviewEntries(rows, { resourceTypes: ["xhr"] }))).toEqual([1, 2]);
    expect(indexesOf(filterPreviewEntries(rows, { resourceTypes: ["image", "fetch"] })))
      .toEqual([3, 4]);
  });

  it("filters by method, ignoring the case of the caller's list", () => {
    expect(indexesOf(filterPreviewEntries(rows, { methods: ["post"] }))).toEqual([2]);
    expect(indexesOf(filterPreviewEntries(rows, { methods: ["GET", "put"] }))).toEqual([0, 1, 3, 4]);
  });

  it("filters by an inclusive status range", () => {
    expect(indexesOf(filterPreviewEntries(rows, { statusMin: 205 }))).toEqual([2, 3, 4]);
    expect(indexesOf(filterPreviewEntries(rows, { statusMax: 201 }))).toEqual([0, 1]);
    expect(indexesOf(filterPreviewEntries(rows, { statusMin: 200, statusMax: 304 })))
      .toEqual([0, 1, 3]);
  });

  it("returns nothing when the status range is inverted", () => {
    expect(filterPreviewEntries(rows, { statusMin: 500, statusMax: 200 })).toEqual([]);
  });

  it("filters by included domain, subdomains included", () => {
    expect(urls(filterPreviewEntries(rows, { includeDomains: ["api.example.com"] })))
      .toEqual([
        "https://api.example.com/v1/items?page=2",
        "https://api.example.com/v1/items",
      ]);
    expect(indexesOf(filterPreviewEntries(rows, { includeDomains: [".example.com"] })))
      .toEqual([0, 1, 2, 3]);
  });

  it("filters by excluded domain, subdomains included", () => {
    expect(indexesOf(filterPreviewEntries(rows, { excludeDomains: ["example.com"] }))).toEqual([4]);
  });

  it("filters by free text over method and url, case-insensitively", () => {
    expect(indexesOf(filterPreviewEntries(rows, { text: "ITEMS" }))).toEqual([1, 2]);
    expect(indexesOf(filterPreviewEntries(rows, { text: "post" }))).toEqual([2]);
    expect(indexesOf(filterPreviewEntries(rows, { text: "other.test/track" }))).toEqual([4]);
    expect(filterPreviewEntries(rows, { text: "no-such-request" })).toEqual([]);
  });

  it("combines filters with AND", () => {
    expect(indexesOf(filterPreviewEntries(rows, {
      resourceTypes: ["xhr"],
      methods: ["get"],
      statusMin: 200,
      statusMax: 299,
      includeDomains: ["api.example.com"],
      text: "page=2",
    }))).toEqual([1]);
  });
});

// -----------------------------------------------------------------------------
// pruneHar
// -----------------------------------------------------------------------------

describe("pruneHar", () => {
  it("keeps the chosen entries in their original order", () => {
    const source = sourceHar();
    const pruned = pruneHar(source, new Set([3, 0]));

    expect(entryUrls(pruned)).toEqual([
      "https://app.example.com/index.html",
      "https://cdn.example.com/logo.png",
    ]);
    expect(pruned.log.entries[0].request.url).toBe("https://app.example.com/index.html");
  });

  it("drops every entry that was not chosen", () => {
    const pruned = pruneHar(sourceHar(), new Set([1]));

    expect(pruned.log.entries).toHaveLength(1);
    expect(pruned.log.entries[0].request.url).toBe("https://api.example.com/v1/items?page=2");
  });

  it("preserves the log metadata, the pages and extra keys", () => {
    const source = sourceHar() as Har & { exportedBy: string };
    source.exportedBy = "test";
    (source.log as unknown as Record<string, unknown>).comment = "exported by test";

    const pruned = pruneHar(source, new Set([2]));
    const log = pruned.log as unknown as Record<string, unknown>;

    expect(pruned.log.version).toBe("1.2");
    expect(pruned.log.creator).toEqual({ name: "DevTools", version: "141.0" });
    expect(pruned.log.pages).toEqual([{ startedDateTime: START, id: "page_1", title: "Example" }]);
    expect(log.comment).toBe("exported by test");
    expect((pruned as unknown as Record<string, unknown>).exportedBy).toBe("test");
  });

  it("returns a new HAR and never mutates the input", () => {
    const source = sourceHar();
    const before = [...source.log.entries];
    const pruned = pruneHar(source, new Set([0, 1]));

    expect(pruned).not.toBe(source);
    expect(pruned.log).not.toBe(source.log);
    expect(pruned.log.entries).not.toBe(source.log.entries);
    expect(source.log.entries).toHaveLength(5);
    expect(source.log.entries).toEqual(before);
  });

  it("ignores indexes that do not exist", () => {
    const pruned = pruneHar(sourceHar(), new Set([99, -1, 1.5]));

    expect(pruned.log.entries).toEqual([]);
  });

  it("yields an empty entry list for an empty selection", () => {
    const pruned = pruneHar(sourceHar(), new Set());

    expect(pruned.log.entries).toEqual([]);
    expect(pruned.log.pages).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// summarize
// -----------------------------------------------------------------------------

describe("summarize", () => {
  it("counts kept and dropped rows against the whole file", () => {
    const rows = harEntries(sourceHar());
    const summary = summarize(rows, new Set([0, 1, 2]));

    expect(summary.total).toBe(5);
    expect(summary.kept).toBe(3);
    expect(summary.dropped).toBe(2);
  });

  it("breaks the kept rows down by resource type and method", () => {
    const rows = harEntries(sourceHar());
    const summary = summarize(rows, new Set([1, 2, 4]));

    expect(summary.byResourceType).toEqual({ xhr: 2, fetch: 1 });
    expect(summary.byMethod).toEqual({ GET: 1, POST: 1, PUT: 1 });
  });

  it("lists the distinct origins of the kept rows in first-appearance order", () => {
    const rows = harEntries(sourceHar());

    expect(summarize(rows, new Set([0, 1, 2])).origins).toEqual([
      "https://app.example.com",
      "https://api.example.com",
    ]);
    expect(summarize(rows, new Set([0, 4])).origins).toEqual([
      "https://app.example.com",
      "https://other.test",
    ]);
  });

  it("reports everything dropped when nothing is selected", () => {
    const summary = summarize(harEntries(sourceHar()), new Set());

    expect(summary.kept).toBe(0);
    expect(summary.dropped).toBe(5);
    expect(summary.byResourceType).toEqual({});
    expect(summary.byMethod).toEqual({});
    expect(summary.origins).toEqual([]);
  });

  it("ignores selected indexes that are not in the given rows", () => {
    const rows = harEntries(sourceHar());
    const summary = summarize(rows, new Set([0, 42]));

    expect(summary.kept).toBe(1);
    expect(summary.dropped).toBe(4);
  });
});

// -----------------------------------------------------------------------------
// Toggles the page builds from what the file actually contains
// -----------------------------------------------------------------------------

describe("availableResourceTypes and availableMethods", () => {
  const rows = harEntries(sourceHar());

  it("lists the resource types present, in the shared vocabulary order", () => {
    expect(availableResourceTypes(rows)).toEqual(["document", "xhr", "fetch", "image"]);
    expect(availableResourceTypes([])).toEqual([]);
  });

  it("lists the methods present once each, in first-appearance order", () => {
    expect(availableMethods(rows)).toEqual(["GET", "POST", "PUT"]);
    expect(availableMethods([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The browser preview must agree with the importer it feeds
// -----------------------------------------------------------------------------

describe("preview pipeline", () => {
  it("imports exactly the rows the preview kept", () => {
    const source = sourceHar();
    const rows = harEntries(source);
    const visible = filterPreviewEntries(rows, { resourceTypes: ["xhr", "fetch"] });
    const keep = new Set(visible.map((row) => row.index));

    const imported = importHar(pruneHar(source, keep), {
      name: "Preview",
      excludeStatic: false,
      useHarTimings: false,
    });

    expect(imported.stats.totalEntries).toBe(3);
    expect(imported.stats.importedEntries).toBe(3);
    expect(urls(visible)).toEqual([
      "https://api.example.com/v1/items?page=2",
      "https://api.example.com/v1/items",
      "https://other.test/track",
    ]);
  });

  it("produces variable suggestions from the pruned HAR alone", () => {
    const source = sourceHar();
    const keep = new Set([1, 2, 3]);
    const imported = importHar(pruneHar(source, keep), {
      name: "Preview",
      excludeStatic: false,
    });
    const { composition } = harGraphToComposition(imported.graph);
    const suggestions = suggestHarVariables(imported.graph, composition);

    expect(composition.nodes).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual(["host", "host"]);
    expect(suggestions.map((suggestion) => suggestion.value)).toEqual([
      "https://api.example.com",
      "https://cdn.example.com",
    ]);
  });
});
