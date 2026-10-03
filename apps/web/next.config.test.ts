// K6F3-04 contract-05 routing: browser same-origin /api/ws/runs/{id} is
// rewritten to the orchestrator's internal /ws/runs/{id}; the orchestrator
// port stays unexposed. K6F7 adds recorder rewrites.
// Pure shape assertions — no server is started.

import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";

const ORCHESTRATOR_ENV = "ORCHESTRATOR_WS_UPSTREAM";
const RECORDER_ENV = "RECORDER_UPSTREAM";

describe("next.config — rewrites", () => {
  afterEach(() => {
    delete process.env[ORCHESTRATOR_ENV];
    delete process.env[RECORDER_ENV];
  });

  it("keeps the standalone output", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("declares a rewrites function", () => {
    expect(typeof nextConfig.rewrites).toBe("function");
  });

  it("defaults to internal upstreams", async () => {
    delete process.env[ORCHESTRATOR_ENV];
    delete process.env[RECORDER_ENV];
    const rules = await nextConfig.rewrites!();
    expect(rules).toEqual([
      { source: "/api/ws/:path*", destination: "http://orchestrator:8080/ws/:path*" },
      { source: "/api/recorder/:path*", destination: "http://recorder:8081/api/recorder/:path*" },
      { source: "/ws/recordings/:path*", destination: "http://recorder:8081/ws/recordings/:path*" },
    ]);
  });

  it("honors the ORCHESTRATOR_WS_UPSTREAM override", async () => {
    process.env[ORCHESTRATOR_ENV] = "http://custom-host:9090";
    const rules = await nextConfig.rewrites!() as Array<{ source: string; destination: string }>;
    expect(rules[0]).toEqual({
      source: "/api/ws/:path*",
      destination: "http://custom-host:9090/ws/:path*",
    });
  });

  it("honors the RECORDER_UPSTREAM override", async () => {
    process.env[RECORDER_ENV] = "http://custom-recorder:9999";
    const rules = await nextConfig.rewrites!() as Array<{ source: string; destination: string }>;
    expect(rules[1]).toEqual({
      source: "/api/recorder/:path*",
      destination: "http://custom-recorder:9999/api/recorder/:path*",
    });
    expect(rules[2]).toEqual({
      source: "/ws/recordings/:path*",
      destination: "http://custom-recorder:9999/ws/recordings/:path*",
    });
  });
});
