import { describe, expect, it } from "vitest";
import {
  MAX_VARIABLES_PER_SET,
  MAX_VARIABLE_VALUE_BYTES,
  parseEnvironmentName,
  parseVariableSetBody,
  prepareVariableReplacement,
  validateVariableSet,
} from "./validation";

const v = (name: string, value = "x", secret = false) => ({ name, value, secret });

describe("validateVariableSet", () => {
  it("accepts a valid set", () => {
    expect(validateVariableSet([v("baseUrl"), v("token", "t", true), v("api.v1-x")])).toEqual([]);
  });

  it("accepts an empty set", () => {
    expect(validateVariableSet([])).toEqual([]);
  });

  it("rejects invalid names with the index and field", () => {
    const errors = validateVariableSet([v("ok"), v("1bad"), v("has space")]);
    expect(errors).toEqual([
      expect.objectContaining({ index: 1, field: "name", code: "invalid-name" }),
      expect.objectContaining({ index: 2, field: "name", code: "invalid-name" }),
    ]);
  });

  it("rejects duplicate names (case-sensitive) on the later occurrence", () => {
    const errors = validateVariableSet([v("a"), v("b"), v("a")]);
    expect(errors).toEqual([
      expect.objectContaining({ index: 2, field: "name", code: "duplicate-name" }),
    ]);
    expect(validateVariableSet([v("a"), v("A")])).toEqual([]);
  });

  it("rejects values over 8 KiB measured in UTF-8 bytes", () => {
    expect(validateVariableSet([v("a", "x".repeat(MAX_VARIABLE_VALUE_BYTES))])).toEqual([]);
    expect(validateVariableSet([v("a", "x".repeat(MAX_VARIABLE_VALUE_BYTES + 1))])).toEqual([
      expect.objectContaining({ index: 0, field: "value", code: "value-too-large" }),
    ]);
    // 4097 two-byte chars = 8194 bytes although length is 4097
    expect(validateVariableSet([v("a", "é".repeat(4097))])).toEqual([
      expect.objectContaining({ index: 0, code: "value-too-large" }),
    ]);
  });

  it("rejects more than 200 variables with a set-level error", () => {
    const ok = Array.from({ length: MAX_VARIABLES_PER_SET }, (_, i) => v(`v${i}`));
    expect(validateVariableSet(ok)).toEqual([]);
    const tooMany = [...ok, v("extra")];
    expect(validateVariableSet(tooMany)).toEqual([
      expect.objectContaining({ index: null, field: null, code: "too-many" }),
    ]);
  });

  it("rejects secrets whose env names collide", () => {
    const errors = validateVariableSet([v("api.key", "1", true), v("API_KEY", "2", true), v("api-key", "3", false)]);
    expect(errors).toEqual([
      expect.objectContaining({ index: null, field: "name", code: "secret-env-collision" }),
    ]);
    expect(errors[0].message).toContain("K6FLOW_VAR_API_KEY");
    expect(errors[0].message).toContain("api.key");
    expect(errors[0].message).toContain("API_KEY");
  });

  it("does not report a collision between a secret and a non-secret", () => {
    expect(validateVariableSet([v("api.key", "1", true), v("API_KEY", "2", false)])).toEqual([]);
  });
});

describe("parseVariableSetBody", () => {
  it("accepts { variables: [...] } with value string, null or omitted", () => {
    const result = parseVariableSetBody({
      variables: [
        { name: "a", value: "1", secret: false },
        { name: "b", value: null, secret: true },
        { name: "c", secret: true },
        { name: "d", value: "2" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      items: [
        { name: "a", value: "1", secret: false },
        { name: "b", value: null, secret: true },
        { name: "c", value: null, secret: true },
        { name: "d", value: "2", secret: false },
      ],
    });
  });

  it("rejects a non-object body or missing array", () => {
    for (const body of [null, [], "x", {}, { variables: {} }]) {
      const result = parseVariableSetBody(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatchObject({ index: null, code: "invalid-shape" });
    }
  });

  it("rejects bad item shapes with the index", () => {
    const result = parseVariableSetBody({
      variables: [{ name: "a", value: "1" }, "nope", { name: 3 }, { name: "x", value: 5 }, { name: "y", secret: "yes" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.index, e.code])).toEqual([
        [1, "invalid-shape"],
        [2, "invalid-shape"],
        [3, "invalid-shape"],
        [4, "invalid-shape"],
      ]);
    }
  });

  it("rejects more than 200 items before per-item work", () => {
    const variables = Array.from({ length: MAX_VARIABLES_PER_SET + 1 }, (_, i) => ({ name: `v${i}`, value: "" }));
    const result = parseVariableSetBody({ variables });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ code: "too-many" })]);
  });
});

describe("prepareVariableReplacement", () => {
  const existing = [v("token", "s3cret", true), v("baseUrl", "https://a", false), v("old", "o", true)];

  it("replaces the whole set; omitted variables are dropped", () => {
    const result = prepareVariableReplacement([{ name: "baseUrl", value: "https://b", secret: false }], existing);
    expect(result).toEqual({ ok: true, variables: [v("baseUrl", "https://b", false)] });
  });

  it("keeps the stored value of a secret sent with value null", () => {
    const result = prepareVariableReplacement(
      [{ name: "token", value: null, secret: true }, { name: "baseUrl", value: "https://a", secret: false }],
      existing,
    );
    expect(result).toEqual({ ok: true, variables: [v("token", "s3cret", true), v("baseUrl", "https://a", false)] });
  });

  it("overwrites a secret when a new value is sent", () => {
    const result = prepareVariableReplacement([{ name: "token", value: "new", secret: true }], existing);
    expect(result).toEqual({ ok: true, variables: [v("token", "new", true)] });
  });

  it("keeps the stored value when a non-secret becomes secret without a value", () => {
    const result = prepareVariableReplacement([{ name: "baseUrl", value: null, secret: true }], existing);
    expect(result).toEqual({ ok: true, variables: [v("baseUrl", "https://a", true)] });
  });

  it("requires a value for a new secret", () => {
    const result = prepareVariableReplacement([{ name: "fresh", value: null, secret: true }], existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ index: 0, field: "value", code: "missing-value" })]);
  });

  it("never carries a secret value into a non-secret variable", () => {
    const result = prepareVariableReplacement([{ name: "token", value: null, secret: false }], existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ index: 0, field: "value", code: "missing-value" })]);
  });

  it("runs set validation on the merged result", () => {
    const result = prepareVariableReplacement(
      [{ name: "token", value: null, secret: true }, { name: "TOKEN", value: "x", secret: false }, { name: "token", value: "y", secret: true }],
      existing,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code).sort()).toEqual(["duplicate-name"]);
    }
  });

  it("reports set errors at the submitted index even after a missing-value item", () => {
    const result = prepareVariableReplacement(
      [{ name: "fresh", value: null, secret: true }, { name: "ok", value: "1", secret: false }, { name: "bad name", value: "2", secret: false }],
      existing,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.index, e.code])).toEqual([
        [0, "missing-value"],
        [2, "invalid-name"],
      ]);
    }
  });

  it("reports collisions in the merged result", () => {
    const result = prepareVariableReplacement(
      [{ name: "old", value: null, secret: true }, { name: "OLD", value: "x", secret: true }],
      existing,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ code: "secret-env-collision" })]);
  });
});

describe("parseEnvironmentName", () => {
  it("trims and accepts a name", () => {
    expect(parseEnvironmentName({ name: "  staging " })).toEqual({ ok: true, name: "staging" });
  });

  it("rejects missing, blank, non-string or over-long names", () => {
    for (const body of [null, {}, { name: "" }, { name: "   " }, { name: 3 }, { name: "x".repeat(101) }]) {
      expect(parseEnvironmentName(body).ok).toBe(false);
    }
    expect(parseEnvironmentName({ name: "x".repeat(100) }).ok).toBe(true);
  });
});
