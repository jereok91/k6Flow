import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorAuthHeaders, orchestratorBaseUrl } from "./proxy";

describe("orchestrator proxy config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ORCHESTRATOR_INTERNAL_URL", undefined);
    vi.stubEnv("ORCHESTRATOR_SERVICE_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the in-cluster orchestrator URL", () => {
    expect(orchestratorBaseUrl()).toBe("http://orchestrator:8080");
  });

  it("defaults to the internal service token", () => {
    expect(orchestratorAuthHeaders()).toEqual({
      Authorization: "Bearer k6flow-internal-token",
    });
  });

  it("reads ORCHESTRATOR_INTERNAL_URL at call time", () => {
    vi.stubEnv("ORCHESTRATOR_INTERNAL_URL", "http://custom:9090");
    expect(orchestratorBaseUrl()).toBe("http://custom:9090");
  });

  it("reads ORCHESTRATOR_SERVICE_TOKEN at call time", () => {
    vi.stubEnv("ORCHESTRATOR_SERVICE_TOKEN", "secret-token");
    expect(orchestratorAuthHeaders()).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("ignores the legacy ORCHESTRATOR_URL / ORCHESTRATOR_TOKEN vars", () => {
    vi.stubEnv("ORCHESTRATOR_URL", "http://localhost:8080");
    vi.stubEnv("ORCHESTRATOR_TOKEN", "");
    expect(orchestratorBaseUrl()).toBe("http://orchestrator:8080");
    expect(orchestratorAuthHeaders()).toEqual({
      Authorization: "Bearer k6flow-internal-token",
    });
  });
});
