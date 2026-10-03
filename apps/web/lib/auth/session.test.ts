import { describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS, isSessionExpired, resolveSessionTtlSeconds } from "./session";

// K6F4-02a: only PURE decision logic is unit-tested here. The DB-backed paths
// (createSession / getSessionUser / revokeSession / revokeUserSessions)
// require a real Postgres and are proven in the K6F4-06 real-stack e2e suite,
// not in this node-env vitest run.

describe("resolveSessionTtlSeconds (K6F4-02a)", () => {
  it("returns the 7-day default when the env var is absent", () => {
    expect(resolveSessionTtlSeconds({})).toBe(604800);
    expect(resolveSessionTtlSeconds(undefined)).toBe(604800);
  });

  it("falls back to the default for non-numeric values", () => {
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "abc" })).toBe(604800);
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "" })).toBe(604800);
  });

  it("falls back to the default for zero or negative values", () => {
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "0" })).toBe(604800);
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "-5" })).toBe(604800);
  });

  it("honors a valid override, including whitespace-padded input", () => {
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "3600" })).toBe(3600);
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: " 86400 " })).toBe(86400);
  });
});

describe("isSessionExpired (K6F4-02a)", () => {
  const now = new Date("2026-01-08T00:00:00Z");

  it("treats expiresAt <= now as expired", () => {
    expect(isSessionExpired(now, now)).toBe(true);
    expect(isSessionExpired(new Date("2026-01-07T23:59:59Z"), now)).toBe(true);
  });

  it("treats expiresAt > now as live", () => {
    expect(isSessionExpired(new Date("2026-01-08T00:00:01Z"), now)).toBe(false);
  });
});

describe("SESSION_TTL_SECONDS constant (K6F4-02a)", () => {
  it("defaults to 604800 (7 days)", () => {
    expect(SESSION_TTL_SECONDS).toBe(604800);
  });
});
