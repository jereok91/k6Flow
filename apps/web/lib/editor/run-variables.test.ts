import { describe, expect, it, vi } from "vitest";
import type { K6TranslationError } from "@k6flow/shared";
import {
  buildRunVariables,
  formatTranslationErrors,
  loadRunVariables,
  parseProxyRunError,
  toVariableInputs,
} from "./run-variables";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("toVariableInputs", () => {
  it("maps the masked GET shape; secrets carry no value", () => {
    expect(toVariableInputs({
      variables: [
        { name: "baseUrl", value: "https://api.test", secret: false },
        { name: "token", secret: true, hasValue: true },
      ],
    })).toEqual([
      { name: "baseUrl", value: "https://api.test", secret: false },
      { name: "token", secret: true },
    ]);
  });

  it("drops any value a secret entry might carry", () => {
    expect(toVariableInputs({ variables: [{ name: "t", value: "leak", secret: true }] }))
      .toEqual([{ name: "t", secret: true }]);
  });

  it.each([
    null, {}, { variables: "x" }, { variables: [{ name: 1, secret: false, value: "" }] },
    { variables: [{ name: "a", secret: "no", value: "" }] },
    { variables: [{ name: "a", secret: false }] },
  ])("rejects a malformed payload %#", (payload) => {
    expect(toVariableInputs(payload)).toBeNull();
  });
});

describe("buildRunVariables", () => {
  it("merges with scenario variables winning by name", () => {
    const merged = buildRunVariables(
      [{ name: "baseUrl", value: "env", secret: false }, { name: "token", secret: true }],
      [{ name: "baseUrl", value: "scenario", secret: false }],
    );
    expect(merged.get("baseUrl")).toEqual({ value: "scenario", secret: false });
    expect(merged.get("token")).toEqual({ secret: true });
  });

  it("lets a scenario secret replace an environment literal", () => {
    const merged = buildRunVariables(
      [{ name: "token", value: "plain", secret: false }],
      [{ name: "token", secret: true }],
    );
    expect(merged.get("token")).toEqual({ secret: true });
  });
});

describe("formatTranslationErrors", () => {
  it("lists every error message", () => {
    const errors: K6TranslationError[] = [
      { code: "unknown-variable", nodeId: "n1", variable: "foo", message: 'Unknown variable "{{foo}}"' },
      { code: "missing-value", nodeId: "n2", variable: "bar", message: 'Variable "{{bar}}" has no value' },
    ];
    const text = formatTranslationErrors(errors);
    expect(text).toContain("Cannot run");
    expect(text).toContain('Unknown variable "{{foo}}"');
    expect(text).toContain('Variable "{{bar}}" has no value');
  });
});

describe("loadRunVariables", () => {
  it("fetches nothing and returns an empty set without scenario or environment", async () => {
    const fetchImpl = vi.fn();
    const result = await loadRunVariables({}, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, variables: new Map() });
  });

  it("fetches both sets and merges them (scenario wins)", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.startsWith("/api/environments/")
      ? jsonResponse({ variables: [{ name: "a", value: "env", secret: false }, { name: "s", secret: true, hasValue: true }] })
      : jsonResponse({ variables: [{ name: "a", value: "scn", secret: false }] }));
    const result = await loadRunVariables({ scenarioId: "sc 1", environmentId: "env-1" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/environments/env-1/variables", expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith("/api/scenarios/sc%201/variables", expect.anything());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variables.get("a")).toEqual({ value: "scn", secret: false });
    expect(result.variables.get("s")).toEqual({ secret: true });
  });

  it("fails with a clear error when a set cannot be loaded", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Forbidden" }, 403));
    const result = await loadRunVariables({ environmentId: "env-x" }, fetchImpl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("environment variables") });
  });

  it("fails on a malformed payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true }));
    const result = await loadRunVariables({ scenarioId: "s1" }, fetchImpl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("scenario variables") });
  });

  it("fails on a network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const result = await loadRunVariables({ scenarioId: "s1" }, fetchImpl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("offline") });
  });
});

describe("parseProxyRunError", () => {
  it("joins the proxy error and its details", () => {
    expect(parseProxyRunError(JSON.stringify({
      error: "Secret variables could not be resolved",
      errors: ["No secret value available for K6FLOW_VAR_TOKEN"],
    }))).toBe("Secret variables could not be resolved: No secret value available for K6FLOW_VAR_TOKEN");
    expect(parseProxyRunError(JSON.stringify({ error: "Forbidden" }))).toBe("Forbidden");
  });

  it.each(["not json", "{}", JSON.stringify({ version: 1, code: "x", message: "y" })])(
    "returns null for other bodies %#", (body) => {
      expect(parseProxyRunError(body)).toBeNull();
    });
});
