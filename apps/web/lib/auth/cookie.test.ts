import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, parseSessionCookie, serializeSessionCookie } from "./cookie";

// K6F4-02a: pure cookie helpers — all cases below run without any request
// context or DB.

describe("serializeSessionCookie (K6F4-02a)", () => {
  it("sets HttpOnly, SameSite=Lax, Path=/, Max-Age and Secure when secure=true", () => {
    const cookie = serializeSessionCookie("tok123", { secure: true, maxAgeSeconds: 3600 });
    expect(cookie).toContain(`${SESSION_COOKIE}=tok123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Secure");
  });

  it("omits the Secure attribute when secure=false", () => {
    const plain = serializeSessionCookie("tok123", { secure: false, maxAgeSeconds: 60 });
    expect(plain).not.toContain("Secure");
    expect(plain).toContain("Max-Age=60");
    expect(plain).toContain("HttpOnly");
  });

  it("floors fractional Max-Age values", () => {
    const cookie = serializeSessionCookie("t", { secure: false, maxAgeSeconds: 90.9 });
    expect(cookie).toContain("Max-Age=90");
  });
});

describe("parseSessionCookie (K6F4-02a)", () => {
  it("extracts the session token from a Cookie header", () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc.def-123; other=x`;
    expect(parseSessionCookie(header)).toBe("abc.def-123");
  });

  it("returns null on missing or malformed input", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie("garbage-without-equals")).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE}=%zz`)).toBeNull();
  });

  it("ignores unrelated cookies", () => {
    expect(parseSessionCookie("a=1; b=2; c=3")).toBeNull();
  });
});
