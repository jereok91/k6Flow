import { describe, expect, it, vi } from "vitest";
import { serializeSessionCookie, SESSION_COOKIE } from "../../../lib/auth/cookie";
import { toSafeUser } from "../../../lib/auth/safe-user";
import type { User } from "../../../lib/db/schema";
import {
  buildClearedCookie,
  classifyLogin,
  INVALID_CREDENTIALS,
  isRequestHttps,
} from "./logic";

const userRow: User = {
  id: "u1",
  username: "alice",
  passwordHash: "scrypt$16384$8$1$deadbeefcafe$0123456789abcdef",
  role: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("classifyLogin (K6F4-02b anti-enumeration)", () => {
  it("classifies unknown user and wrong password identically", () => {
    const wrongPassword = classifyLogin(userRow, "wrong", () => false);
    const unknownUser = classifyLogin(null, "anything", () => true);
    expect(unknownUser).toBe("invalid-credentials");
    expect(wrongPassword).toBe("invalid-credentials");
    // Same classification → the route returns ONE status+body for both.
    expect(unknownUser).toBe(wrongPassword);
  });

  it("classifies a matching password as ok", () => {
    expect(classifyLogin(userRow, "pw", () => true)).toBe("ok");
  });

  it("never runs verify for a missing user", () => {
    const verify = vi.fn(() => true);
    expect(classifyLogin(null, "pw", verify)).toBe("invalid-credentials");
    expect(verify).not.toHaveBeenCalled();
  });

  it("passes the raw password to verify without re-trimming", () => {
    const seen: string[] = [];
    classifyLogin(userRow, "  spaced secret  ", (plain) => {
      seen.push(plain);
      return true;
    });
    expect(seen).toEqual(["  spaced secret  "]);
  });

  it("uses one constant message for both failure cases", () => {
    // The route maps both classifications to jsonError(401, INVALID_CREDENTIALS);
    // pinning the constant prevents a future branch that echoes user input.
    expect(INVALID_CREDENTIALS).toBe("Invalid username or password");
  });
});

describe("isRequestHttps (K6F4-02b Secure heuristic)", () => {
  it("trusts x-forwarded-proto https", () => {
    const headers = new Headers({ "x-forwarded-proto": "https" });
    expect(isRequestHttps(headers, "http://localhost:3000/api/auth/login")).toBe(true);
  });

  it("returns false for x-forwarded-proto http", () => {
    const headers = new Headers({ "x-forwarded-proto": "http" });
    expect(isRequestHttps(headers, "https://example.com/api/auth/login")).toBe(false);
  });

  it("uses the first value of a comma-joined forwarded proto", () => {
    const headers = new Headers({ "x-forwarded-proto": "https, http" });
    expect(isRequestHttps(headers)).toBe(true);
  });

  it("falls back to the URL protocol when the header is absent", () => {
    expect(isRequestHttps(new Headers(), "https://example.com/x")).toBe(true);
    expect(isRequestHttps(new Headers(), "http://localhost:3000/x")).toBe(false);
  });

  it("returns false when neither source is available or URL is malformed", () => {
    expect(isRequestHttps(new Headers())).toBe(false);
    expect(isRequestHttps(new Headers(), "not a url")).toBe(false);
  });
});

describe("buildClearedCookie (K6F4-02b logout clearing)", () => {
  it("matches the live cookie flags with Max-Age=0 and the same name", () => {
    const cleared = buildClearedCookie(false);
    expect(cleared).toBe(serializeSessionCookie("", { secure: false, maxAgeSeconds: 0 }));
    expect(cleared.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).not.toContain("Secure");
  });

  it("adds Secure only when the request was HTTPS", () => {
    expect(buildClearedCookie(true)).toContain("Secure");
    expect(buildClearedCookie(true)).toBe(
      serializeSessionCookie("", { secure: true, maxAgeSeconds: 0 }),
    );
  });
});

describe("login success body shape (K6F4-02b)", () => {
  it("maps the user row to SafeUser with no passwordHash", () => {
    const safe = toSafeUser(userRow);
    expect(safe).toEqual({
      id: "u1",
      username: "alice",
      role: "user",
      createdAt: userRow.createdAt,
    });
    expect(safe).not.toHaveProperty("passwordHash");
  });
});
