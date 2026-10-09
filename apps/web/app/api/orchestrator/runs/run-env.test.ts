import { describe, expect, it, vi } from "vitest";
import type { VariableDefinition } from "@k6flow/shared";
import {
  buildRunEnv,
  parseRunEnvRequest,
  prepareRunStart,
  toOrchestratorBody,
  type ResolveVariables,
} from "./run-env";

const SECRET = "s3cret-value-from-db";
const actor = { id: "user-1", role: "user" as const };
const runBody = {
  version: 1, script: "export default function () {}", vus: 1, durationMs: 1000,
  cpuMillis: 500, memoryMiB: 256, attachments: [],
};

describe("parseRunEnvRequest", () => {
  it("defaults to no scenario, no environment and no required env", () => {
    expect(parseRunEnvRequest({})).toEqual({
      ok: true, value: { scenarioId: null, environmentId: null, requiredEnv: [] },
    });
  });

  it("reads scenarioId, environmentId and de-duplicated requiredEnv", () => {
    expect(parseRunEnvRequest({
      scenarioId: "sc-1", environmentId: "env-1",
      requiredEnv: ["K6FLOW_VAR_TOKEN", "K6FLOW_VAR_TOKEN", "K6FLOW_VAR_KEY"],
    })).toEqual({
      ok: true,
      value: { scenarioId: "sc-1", environmentId: "env-1", requiredEnv: ["K6FLOW_VAR_KEY", "K6FLOW_VAR_TOKEN"] },
    });
  });

  it.each([
    [{ requiredEnv: "K6FLOW_VAR_A" }],
    [{ requiredEnv: [1] }],
    [{ requiredEnv: ["PATH"] }],
    [{ requiredEnv: ["K6FLOW_SCRIPT"] }],
    [{ requiredEnv: Array.from({ length: 101 }, (_, i) => `K6FLOW_VAR_V${i}`) }],
    [{ environmentId: 42 }],
    [{ environmentId: "" }],
    [{ scenarioId: 5 }],
  ])("rejects malformed fields %#", (body) => {
    expect(parseRunEnvRequest(body).ok).toBe(false);
  });

  it("treats a null environmentId as none", () => {
    const parsed = parseRunEnvRequest({ environmentId: null });
    expect(parsed).toEqual({ ok: true, value: { scenarioId: null, environmentId: null, requiredEnv: [] } });
  });
});

describe("buildRunEnv", () => {
  const resolved: VariableDefinition[] = [
    { name: "token", value: SECRET, secret: true },
    { name: "api.key", value: "k-1", secret: true },
    { name: "baseUrl", value: "https://api.test", secret: false },
    { name: "empty", value: "", secret: true },
  ];

  it("maps only the requested secret env names", () => {
    expect(buildRunEnv(["K6FLOW_VAR_TOKEN"], resolved)).toEqual({
      ok: true, env: { K6FLOW_VAR_TOKEN: SECRET },
    });
    expect(buildRunEnv(["K6FLOW_VAR_API_KEY", "K6FLOW_VAR_TOKEN"], resolved)).toEqual({
      ok: true, env: { K6FLOW_VAR_API_KEY: "k-1", K6FLOW_VAR_TOKEN: SECRET },
    });
  });

  it("returns an empty env when nothing is required", () => {
    expect(buildRunEnv([], resolved)).toEqual({ ok: true, env: {} });
  });

  it("never exposes non-secret variables as env", () => {
    const result = buildRunEnv(["K6FLOW_VAR_BASEURL"], resolved);
    expect(result.ok).toBe(false);
  });

  it("rejects required env without a resolvable secret value, without leaking values", () => {
    const result = buildRunEnv(["K6FLOW_VAR_MISSING", "K6FLOW_VAR_EMPTY", "K6FLOW_VAR_TOKEN"], resolved);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(" ")).toContain("K6FLOW_VAR_MISSING");
    expect(result.errors.join(" ")).toContain("K6FLOW_VAR_EMPTY");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects merged sets with secret env collisions", () => {
    const result = buildRunEnv(["K6FLOW_VAR_TOKEN"], [
      ...resolved,
      { name: "TOKEN", value: "other", secret: true },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("K6FLOW_VAR_TOKEN");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("other");
  });
});

describe("toOrchestratorBody", () => {
  it("strips proxy-only and client env fields, then adds the server env", () => {
    const out = toOrchestratorBody({
      ...runBody, scenarioId: "sc", scenarioName: "n", environmentId: "e",
      requiredEnv: ["K6FLOW_VAR_TOKEN"], env: { K6FLOW_VAR_TOKEN: "client-forged" },
    }, { K6FLOW_VAR_TOKEN: SECRET });
    expect(out).toEqual({ ...runBody, env: { K6FLOW_VAR_TOKEN: SECRET } });
  });

  it("omits env when empty (and still drops a client env)", () => {
    const out = toOrchestratorBody({ ...runBody, env: { K6FLOW_VAR_X: "forged" } }, {});
    expect(out).toEqual(runBody);
  });
});

describe("prepareRunStart", () => {
  const okResolve = (rows: VariableDefinition[]): ResolveVariables =>
    vi.fn(async () => ({ ok: true as const, value: rows }));

  it("resolves secrets server-side and forwards only the required env", async () => {
    const resolve = okResolve([
      { name: "token", value: SECRET, secret: true },
      { name: "unused", value: "nope", secret: true },
    ]);
    const result = await prepareRunStart({
      ...runBody, scenarioId: "sc-1", environmentId: "env-1",
      requiredEnv: ["K6FLOW_VAR_TOKEN"], env: { K6FLOW_VAR_UNUSED: "forged" },
    }, actor, resolve);
    expect(resolve).toHaveBeenCalledWith(actor, "sc-1", "env-1");
    expect(result).toEqual({ ok: true, orchestratorBody: { ...runBody, env: { K6FLOW_VAR_TOKEN: SECRET } } });
  });

  it("checks scenario ownership even without variables", async () => {
    const resolve: ResolveVariables = vi.fn(async () => ({ ok: false as const, reason: "forbidden" as const }));
    const result = await prepareRunStart({ ...runBody, scenarioId: "sc-other" }, actor, resolve);
    expect(resolve).toHaveBeenCalledWith(actor, "sc-other", null);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("maps an unknown scenario or environment to 404", async () => {
    const resolve: ResolveVariables = vi.fn(async () => ({ ok: false as const, reason: "not-found" as const }));
    const result = await prepareRunStart({ ...runBody, environmentId: "env-x" }, actor, resolve);
    expect(resolve).toHaveBeenCalledWith(actor, null, "env-x");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("skips resolution for an ad-hoc run without variables", async () => {
    const resolve: ResolveVariables = vi.fn();
    const result = await prepareRunStart({ ...runBody, env: { K6FLOW_VAR_A: "forged" } }, actor, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, orchestratorBody: runBody });
  });

  it("rejects required env with no variable source as 422", async () => {
    const resolve: ResolveVariables = vi.fn();
    const result = await prepareRunStart({ ...runBody, requiredEnv: ["K6FLOW_VAR_TOKEN"] }, actor, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("rejects an unresolvable required secret as 422 without values", async () => {
    const resolve = okResolve([{ name: "other", value: SECRET, secret: true }]);
    const result = await prepareRunStart({
      ...runBody, scenarioId: "sc-1", requiredEnv: ["K6FLOW_VAR_TOKEN"],
    }, actor, resolve);
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects malformed proxy fields as 400", async () => {
    const result = await prepareRunStart({ ...runBody, requiredEnv: ["PATH"] }, actor, vi.fn());
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a non-object body as 400", async () => {
    const result = await prepareRunStart(["x"], actor, vi.fn());
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
