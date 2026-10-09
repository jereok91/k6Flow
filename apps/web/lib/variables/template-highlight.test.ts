// k6flow-variables V-T4: pure token logic for `{{name}}` highlight and autocomplete.

import { describe, expect, it } from "vitest";
import {
  applyAutocomplete,
  collectGraphVariables,
  filterVariableNames,
  getAutocompleteContext,
  segmentTemplate,
} from "./template-highlight";
import { mapServerErrors, toReplacePayload, toVariableRows, validateVariableRows } from "./use-variables";

describe("segmentTemplate", () => {
  const known = new Set(["baseUrl", "token"]);

  it("returns a single text segment when there are no placeholders", () => {
    expect(segmentTemplate("https://api.example.com", known)).toEqual([
      { type: "text", value: "https://api.example.com" },
    ]);
  });

  it("returns no segments for an empty string", () => {
    expect(segmentTemplate("", known)).toEqual([]);
  });

  it("marks known and unknown variables", () => {
    expect(segmentTemplate("{{baseUrl}}/users/{{ userId }}?t={{token}}", known)).toEqual([
      { type: "known", name: "baseUrl" },
      { type: "text", value: "/users/" },
      { type: "unknown", name: "userId" },
      { type: "text", value: "?t=" },
      { type: "known", name: "token" },
    ]);
  });

  it("keeps malformed placeholders as text", () => {
    expect(segmentTemplate("a {{bad name}} {{}} {{x", known)).toEqual([
      { type: "text", value: "a {{bad name}} {{}} {{x" },
    ]);
  });

  it("accepts an array of known names", () => {
    expect(segmentTemplate("{{token}}", ["token"])).toEqual([{ type: "known", name: "token" }]);
  });
});

describe("getAutocompleteContext", () => {
  it("returns null when the caret is not inside an open placeholder", () => {
    expect(getAutocompleteContext("https://x", 9)).toBeNull();
    expect(getAutocompleteContext("{{a}} b", 7)).toBeNull();
    expect(getAutocompleteContext("{a", 2)).toBeNull();
  });

  it("opens right after typing {{", () => {
    expect(getAutocompleteContext("https://{{", 10)).toEqual({ start: 8, end: 10, query: "" });
  });

  it("captures the partial name before the caret", () => {
    expect(getAutocompleteContext("x {{bas", 7)).toEqual({ start: 2, end: 7, query: "bas" });
  });

  it("ignores leading whitespace inside the braces", () => {
    expect(getAutocompleteContext("{{ to", 5)).toEqual({ start: 0, end: 5, query: "to" });
  });

  it("extends the replaced range over the rest of the name and closing braces", () => {
    // caret after "{{ba" in "{{baseUrl}}/x"
    expect(getAutocompleteContext("{{baseUrl}}/x", 4)).toEqual({ start: 0, end: 11, query: "ba" });
  });

  it("returns null for characters that cannot be part of a name", () => {
    expect(getAutocompleteContext("{{a b", 5)).toBeNull();
    expect(getAutocompleteContext("{{1abc", 6)).toBeNull();
  });

  it("uses the closest {{ before the caret", () => {
    expect(getAutocompleteContext("{{a}} {{b", 9)).toEqual({ start: 6, end: 9, query: "b" });
  });

  it("returns null when the caret is out of range", () => {
    expect(getAutocompleteContext("{{a", -1)).toBeNull();
    expect(getAutocompleteContext("{{a", 10)).toBeNull();
  });
});

describe("filterVariableNames", () => {
  const names = ["token", "baseUrl", "apiToken", "userId"];

  it("returns all names sorted for an empty query", () => {
    expect(filterVariableNames(names, "")).toEqual(["apiToken", "baseUrl", "token", "userId"]);
  });

  it("puts prefix matches before substring matches, case-insensitively", () => {
    expect(filterVariableNames(names, "TO")).toEqual(["token", "apiToken"]);
  });

  it("returns nothing when no name matches", () => {
    expect(filterVariableNames(names, "zzz")).toEqual([]);
  });
});

describe("applyAutocomplete", () => {
  it("inserts {{name}} over the context range and moves the caret after it", () => {
    const text = "https://{{ba/users";
    const ctx = getAutocompleteContext(text, 12)!;
    expect(applyAutocomplete(text, ctx, "baseUrl")).toEqual({
      text: "https://{{baseUrl}}/users",
      caret: 19,
    });
  });

  it("replaces an existing complete placeholder instead of duplicating braces", () => {
    const text = "{{baseUrl}}/x";
    const ctx = getAutocompleteContext(text, 4)!;
    expect(applyAutocomplete(text, ctx, "token")).toEqual({ text: "{{token}}/x", caret: 9 });
  });
});

describe("collectGraphVariables", () => {
  it("collects names from HTTP url, literal header values and body, and auth URL", () => {
    const nodes = [
      {
        data: {
          kind: "authentication",
          parameters: { method: { kind: "http", request: { method: "POST", url: { kind: "literal", value: "{{authUrl}}/login" } } } },
        },
      },
      {
        data: {
          kind: "http-request",
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "{{baseUrl}}/users" },
            headers: [
              { name: "Authorization", value: { kind: "literal", value: "Bearer {{token}}" } },
              { name: "X-Ref", value: { kind: "reference", reference: { producerNodeId: "a", output: "t" } } },
            ],
            body: { kind: "json", value: { kind: "literal", value: '{"id":"{{userId}}","u":"{{baseUrl}}"}' } },
          },
        },
      },
      { data: { kind: "user-pool", parameters: { manualUsers: [{ user: "{{nope}}" }] } } },
      { data: { kind: "http-request" } },
    ];
    expect(collectGraphVariables(nodes)).toEqual(["authUrl", "baseUrl", "token", "userId"]);
  });

  it("ignores reference URLs and bodies of kind none", () => {
    const nodes = [
      {
        data: {
          kind: "http-request",
          parameters: { method: "GET", url: { kind: "reference", reference: {} }, body: { kind: "none" } },
        },
      },
    ];
    expect(collectGraphVariables(nodes)).toEqual([]);
  });
});

describe("variable rows", () => {
  it("builds rows from masked variables without any secret value", () => {
    const rows = toVariableRows([
      { name: "baseUrl", value: "https://x", secret: false },
      { name: "token", secret: true, hasValue: true },
    ]);
    expect(rows.map(({ key: _key, ...rest }) => rest)).toEqual([
      { name: "baseUrl", value: "https://x", secret: false, originalName: "baseUrl", storedSecret: false },
      { name: "token", value: "", secret: true, originalName: "token", storedSecret: true },
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("sends null for an untouched stored secret and the typed value otherwise", () => {
    const rows = toVariableRows([
      { name: "token", secret: true, hasValue: true },
      { name: "key", secret: true, hasValue: true },
      { name: "baseUrl", value: "https://x", secret: false },
    ]);
    rows[1] = { ...rows[1], value: "new-secret" };
    expect(toReplacePayload(rows)).toEqual([
      { name: "token", value: null, secret: true },
      { name: "key", value: "new-secret", secret: true },
      { name: "baseUrl", value: "https://x", secret: false },
    ]);
  });

  it("validates names, duplicates and secrets without a value", () => {
    const rows = toVariableRows([
      { name: "token", secret: true, hasValue: true },
      { name: "ok", value: "1", secret: false },
    ]);
    const edited = [
      ...rows,
      { key: "n1", name: "", value: "", secret: false, originalName: null, storedSecret: false },
      { key: "n2", name: "1bad", value: "", secret: false, originalName: null, storedSecret: false },
      { key: "n3", name: "ok", value: "2", secret: false, originalName: null, storedSecret: false },
      { key: "n4", name: "newSecret", value: "", secret: true, originalName: null, storedSecret: false },
    ];
    const errors = validateVariableRows(edited);
    expect(errors[rows[0].key]).toBeUndefined();
    expect(errors[rows[1].key]?.name).toMatch(/Duplicate/);
    expect(errors.n1?.name).toMatch(/required/);
    expect(errors.n2?.name).toMatch(/Invalid/);
    expect(errors.n3?.name).toMatch(/Duplicate/);
    expect(errors.n4?.value).toMatch(/value/);
  });

  it("requires a new value when a stored secret is renamed", () => {
    const rows = toVariableRows([{ name: "token", secret: true, hasValue: true }]);
    const renamed = [{ ...rows[0], name: "token2" }];
    expect(validateVariableRows(renamed)[rows[0].key]?.value).toMatch(/value/);
    expect(toReplacePayload(renamed)).toEqual([{ name: "token2", value: null, secret: true }]);
  });

  it("maps server 422 errors to rows by index and keeps set-level errors apart", () => {
    const rows = toVariableRows([
      { name: "a", value: "1", secret: false },
      { name: "b", value: "2", secret: false },
    ]);
    const mapped = mapServerErrors(rows, [
      { index: 1, field: "name", code: "invalid-name", message: "bad name" },
      { index: 0, field: "value", code: "value-too-large", message: "too big" },
      { index: null, field: "name", code: "secret-env-collision", message: "collision" },
      { index: 9, field: "name", code: "invalid-name", message: "stray" },
    ]);
    expect(mapped.rows[rows[1].key]).toEqual({ name: "bad name" });
    expect(mapped.rows[rows[0].key]).toEqual({ value: "too big" });
    expect(mapped.general).toEqual(["collision", "stray"]);
  });
});
