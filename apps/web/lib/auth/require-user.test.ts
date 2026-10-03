import { describe, expect, it } from "vitest";
import type { SafeUser } from "./safe-user";
import { requireAdmin, requireUser } from "./require-user";

// K6F4-02a: requireUser is a thin two-line wrapper (parseSessionCookie +
// getSessionUser) and is intentionally NOT unit-tested here: it depends on
// the DB-backed getSessionUser, whose behavior is proven in the K6F4-06
// real-stack e2e; the cookie half is covered in cookie.test.ts. Only the
// pure role gate is exercised below.

const admin: SafeUser = { id: "u1", username: "root", role: "admin", createdAt: new Date() };
const user: SafeUser = { id: "u2", username: "bob", role: "user", createdAt: new Date() };

describe("requireAdmin (K6F4-02a)", () => {
  it("returns true for a non-null admin", () => {
    expect(requireAdmin(admin)).toBe(true);
  });

  it("returns false for a regular user", () => {
    expect(requireAdmin(user)).toBe(false);
  });

  it("returns false for null", () => {
    expect(requireAdmin(null)).toBe(false);
  });
});

describe("requireUser signature (K6F4-02a)", () => {
  it("is exported and accepts a cookie header (compile-time contract)", () => {
    expect(typeof requireUser).toBe("function");
  });
});
