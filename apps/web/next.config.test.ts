// K6F3-04 contract-05 routing: browser same-origin /api/ws/runs/{id} is
// rewritten to the orchestrator's internal /ws/runs/{id}; the orchestrator
// port stays unexposed. Pure shape assertions — no server is started.

import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";

const UPSTREAM_ENV = "ORCHESTRATOR_WS_UPSTREAM";

describe("next.config — K6F3-04 WS rewrite", () => {
  afterEach(() => {
    delete process.env[UPSTREAM_ENV];
  });

  it("keeps the standalone output", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("declares a rewrites function", () => {
    expect(typeof nextConfig.rewrites).toBe("function");
  });

  it("defaults to the internal orchestrator upstream", async () => {
    delete process.env[UPSTREAM_ENV];
    const rules = await nextConfig.rewrites!();
    expect(rules).toEqual([
      { source: "/api/ws/:path*", destination: "http://orchestrator:8080/ws/:path*" },
    ]);
  });

  it("honors the ORCHESTRATOR_WS_UPSTREAM override", async () => {
    process.env[UPSTREAM_ENV] = "http://custom-host:9090";
    const rules = await nextConfig.rewrites!();
    expect(rules).toEqual([
      { source: "/api/ws/:path*", destination: "http://custom-host:9090/ws/:path*" },
    ]);
  });
});
