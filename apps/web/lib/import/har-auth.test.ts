import { describe, expect, it } from "vitest";
import type { Har, HarEntry } from "@k6flow/shared";
import { applyAuthToHar, authHeaderFor, base64Encode, buildUploadHar, entryIndexes } from "./har-auth";
import type { HarAuthConfig } from "./har-auth";

const START = "2026-01-01T00:00:00.000Z";

/** One HAR entry: a GET to `url` carrying `headers`. */
function entry(url: string, headers: Array<{ name: string; value: string }> = []): HarEntry {
  return {
    startedDateTime: START,
    time: 10,
    request: {
      method: "GET", url, httpVersion: "http/2", headers, queryString: [], headersSize: 0, bodySize: 0,
    },
    response: {
      status: 200, statusText: "OK", httpVersion: "http/2", headers: [],
      content: { size: 1, mimeType: "application/json" }, redirectURL: "", headersSize: 0, bodySize: 1,
    },
    cache: {},
    timings: { send: 0, wait: 10, receive: 0 },
  };
}

/** Browser-shaped HAR: log metadata, five requests, the first one already has a header. */
function sourceHar(): Har {
  return {
    log: {
      version: "1.2",
      creator: { name: "DevTools", version: "141.0" },
      pages: [{ startedDateTime: START, id: "page_1", title: "Example" }],
      entries: [
        entry("https://api.example.com/v1/items", [{ name: "Accept", value: "application/json" }]),
        entry("https://api.example.com/v1/items/1"),
        entry("https://api.example.com/v1/orders"),
        entry("https://api.example.com/v1/orders/9"),
        entry("https://api.example.com/v1/health"),
      ],
    },
  };
}

const entryUrls = (har: Har): string[] => har.log.entries.map((row) => row.request.url);

/** The request header `name` (case-insensitive), or undefined when the entry lacks it. */
const headerOf = (
  har: Har,
  index: number,
  name = "Authorization",
): { name: string; value: string } | undefined =>
  har.log.entries[index].request.headers.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );

/** Indexes of the entries that carry an Authorization header. */
const indexesWithHeader = (har: Har): number[] =>
  har.log.entries
    .map((_row, index) => (headerOf(har, index) === undefined ? undefined : index))
    .filter((index): index is number => index !== undefined);

const BEARER: HarAuthConfig = { kind: "bearer", token: "t-1" };

describe("authHeaderFor", () => {
  it("builds the header of every scheme", () => {
    expect(authHeaderFor({ kind: "bearer", token: "abc.def" }))
      .toEqual({ name: "Authorization", value: "Bearer abc.def" });
    expect(authHeaderFor({ kind: "basic", username: "user", password: "pass" }))
      .toEqual({ name: "Authorization", value: "Basic dXNlcjpwYXNz" });
    expect(authHeaderFor({ kind: "api-key", headerValue: "k-123" }))
      .toEqual({ name: "x-api-key", value: "k-123" });
    expect(authHeaderFor({ kind: "api-key", headerName: "X-Api-Key", headerValue: "k-123" }))
      .toEqual({ name: "X-Api-Key", value: "k-123" });
    expect(authHeaderFor({ kind: "cookie", cookie: "session=abc" }))
      .toEqual({ name: "Cookie", value: "session=abc" });
    expect(authHeaderFor({ kind: "custom-header", headerName: "X-Tenant", headerValue: "acme" }))
      .toEqual({ name: "X-Tenant", value: "acme" });
  });

  it("returns null for the none scheme and for incomplete configs", () => {
    expect(authHeaderFor({ kind: "none" })).toBeNull();
    expect(authHeaderFor({ kind: "bearer" })).toBeNull();
    expect(authHeaderFor({ kind: "bearer", token: "   " })).toBeNull();
    expect(authHeaderFor({ kind: "basic", password: "pass" })).toBeNull();
    expect(authHeaderFor({ kind: "api-key" })).toBeNull();
    expect(authHeaderFor({ kind: "api-key", headerName: "X-Api-Key" })).toBeNull();
    expect(authHeaderFor({ kind: "cookie", cookie: "" })).toBeNull();
    expect(authHeaderFor({ kind: "custom-header", headerName: "X-Tenant" })).toBeNull();
    expect(authHeaderFor({ kind: "custom-header", headerValue: "acme" })).toBeNull();
  });

  it("base64-encodes without Buffer or btoa, padding included", () => {
    expect(base64Encode("user:pass")).toBe("dXNlcjpwYXNz");
    expect(base64Encode("a")).toBe("YQ==");
    expect(base64Encode("ab")).toBe("YWI=");
    expect(base64Encode("abc")).toBe("YWJj");
    expect(base64Encode("")).toBe("");
  });
});

describe("applyAuthToHar", () => {
  it("adds the header only to the chosen indexes", () => {
    const result = applyAuthToHar(sourceHar(), BEARER, new Set([1, 3]));
    expect(indexesWithHeader(result)).toEqual([1, 3]);
    expect(headerOf(result, 1)?.value).toBe("Bearer t-1");
    expect(headerOf(result, 3)?.value).toBe("Bearer t-1");
  });

  it("applies to the chosen rows in the order they appear in the file", () => {
    const result = applyAuthToHar(sourceHar(), BEARER, new Set([4, 2]));
    expect(indexesWithHeader(result)).toEqual([2, 4]);
    expect(entryUrls(result)).toEqual(entryUrls(sourceHar()));
  });

  it("keeps the other headers and replaces a same-name header whatever its case", () => {
    const source = sourceHar();
    source.log.entries[2].request.headers = [
      { name: "accept", value: "application/json" },
      { name: "authorization", value: "Bearer stale" },
    ];

    const result = applyAuthToHar(source, BEARER, new Set([0, 2]));
    expect(result.log.entries[0].request.headers).toEqual([
      { name: "Accept", value: "application/json" },
      { name: "Authorization", value: "Bearer t-1" },
    ]);
    expect(result.log.entries[2].request.headers).toEqual([
      { name: "accept", value: "application/json" },
      { name: "Authorization", value: "Bearer t-1" },
    ]);
  });

  it("collapses duplicated same-name headers into a single one", () => {
    const source = sourceHar();
    source.log.entries[1].request.headers = [
      { name: "Authorization", value: "Bearer old" },
      { name: "authorization", value: "Bearer older" },
    ];

    const result = applyAuthToHar(source, BEARER, new Set([1]));
    expect(result.log.entries[1].request.headers)
      .toEqual([{ name: "Authorization", value: "Bearer t-1" }]);
  });

  it("returns the entries unchanged when the config produces no header", () => {
    const source = sourceHar();
    const result = applyAuthToHar(source, { kind: "none" }, new Set([0, 1]));
    expect(result.log.entries).toEqual(source.log.entries);
    expect(result.log.entries[0].request.headers).toHaveLength(1);
  });

  it("returns the entries unchanged when no row is chosen", () => {
    const source = sourceHar();
    expect(applyAuthToHar(source, BEARER, new Set()).log.entries).toEqual(source.log.entries);
  });

  it("does not mutate the input and preserves the log metadata", () => {
    const source = { ...sourceHar(), comment: "exported by devtools" } as Har;
    const before = JSON.stringify(source);
    const result = applyAuthToHar(source, BEARER, new Set([1]));
    expect(JSON.stringify(source)).toBe(before);
    expect(result).not.toBe(source);
    expect(result.log.version).toBe("1.2");
    expect(result.log.creator).toEqual({ name: "DevTools", version: "141.0" });
    expect(result.log.pages).toEqual(source.log.pages);
    expect(result.log.entries).toHaveLength(5);
    expect((result as { comment?: string }).comment).toBe("exported by devtools");
  });

  it("adds a Cookie header for the cookie scheme", () => {
    const result = applyAuthToHar(sourceHar(), { kind: "cookie", cookie: "session=abc" }, new Set([0]));
    expect(headerOf(result, 0, "Cookie")).toEqual({ name: "Cookie", value: "session=abc" });
    expect(headerOf(result, 0)).toBeUndefined();
  });
});

describe("buildUploadHar", () => {
  it("prunes to the selection and stamps only the rows picked in scope \"some\"", () => {
    const result = buildUploadHar(
      sourceHar(),
      { kind: "bearer", token: "t-1", scope: "some" },
      new Set([0, 1, 2, 3]),
      new Set([1, 3]),
    );

    expect(entryUrls(result)).toEqual([
      "https://api.example.com/v1/items",
      "https://api.example.com/v1/items/1",
      "https://api.example.com/v1/orders",
      "https://api.example.com/v1/orders/9",
    ]);
    expect(indexesWithHeader(result)).toEqual([1, 3]);
  });

  it("stamps every uploaded row when the scope is \"all\", ignoring the picked rows", () => {
    const result = buildUploadHar(
      sourceHar(),
      { kind: "bearer", token: "t-1", scope: "all" },
      new Set([1, 2]),
      new Set([1]),
    );

    expect(entryUrls(result)).toEqual([
      "https://api.example.com/v1/items/1",
      "https://api.example.com/v1/orders",
    ]);
    expect(indexesWithHeader(result)).toEqual([0, 1]);
  });

  it("prunes without touching headers when the config produces no header", () => {
    const result = buildUploadHar(sourceHar(), { kind: "none" }, new Set([1]), null);
    expect(result.log.entries).toHaveLength(1);
    expect(result.log.entries[0].request.headers).toEqual([]);
  });

  it("drops the auth header of rows that are not uploaded", () => {
    const result = buildUploadHar(
      sourceHar(),
      { kind: "bearer", token: "t-1", scope: "some" },
      new Set([1]),
      new Set([0, 1]),
    );
    expect(result.log.entries).toHaveLength(1);
    expect(indexesWithHeader(result)).toEqual([0]);
  });
});

describe("entryIndexes", () => {
  it("addresses every entry of a HAR so an already pruned HAR can be previewed as-is", () => {
    expect([...entryIndexes(sourceHar())]).toEqual([0, 1, 2, 3, 4]);
    expect([...entryIndexes({ log: { ...sourceHar().log, entries: [] } })]).toEqual([]);
  });
});
