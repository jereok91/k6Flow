import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/healthz", () => {
  it("reports process readiness as JSON without caching", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns a fresh response on every probe", async () => {
    const first = GET();
    const second = GET();

    expect(first).not.toBe(second);
    expect(await first.json()).toEqual({ status: "ok" });
    expect(await second.json()).toEqual({ status: "ok" });
  });
});
