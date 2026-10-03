// K6F4-03: unit tests for the pure user-management decision logic. No Next
// server, no DB — DB-backed paths (insert/delete/update/list, unique
// constraint mapping) are proven in the K6F4-06 real-stack e2e.
import { describe, expect, it } from "vitest";
import type { User } from "../../../lib/db/schema";
import {
  MIN_PASSWORD_LENGTH,
  classifyAdminAccess,
  checkDeleteTarget,
  checkRoleChangeTarget,
  parseCreateUserBody,
  parsePatchRoleBody,
  toSafeUserList,
} from "./logic";

const admin = {
  id: "u-admin",
  username: "root",
  role: "admin" as const,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
const plainUser = { ...admin, id: "u-bob", username: "bob", role: "user" as const };

describe("classifyAdminAccess (K6F4-03 admin gate)", () => {
  it("allows a non-null admin", () => {
    expect(classifyAdminAccess(admin)).toBe("ok");
  });

  it("denies an authenticated non-admin as forbidden (403)", () => {
    expect(classifyAdminAccess(plainUser)).toBe("forbidden");
  });

  it("denies a missing session as unauthorized (401)", () => {
    expect(classifyAdminAccess(null)).toBe("unauthorized");
  });
});

describe("parseCreateUserBody (K6F4-03 POST /api/users)", () => {
  it("accepts a valid body and returns raw values", () => {
    const parsed = parseCreateUserBody({
      username: "alice",
      password: "correct horse battery",
      role: "user",
    });
    expect(parsed).toEqual({
      ok: true,
      username: "alice",
      password: "correct horse battery",
      role: "user",
    });
  });

  it("accepts role admin", () => {
    const parsed = parseCreateUserBody({
      username: "alice",
      password: "correct horse battery",
      role: "admin",
    });
    expect(parsed.ok && parsed.role).toBe("admin");
  });

  it("rejects a missing or blank username, naming the problem", () => {
    const missing = parseCreateUserBody({ password: "correct horse battery", role: "user" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/username/);
    const blank = parseCreateUserBody({ username: "   ", password: "correct horse battery", role: "user" });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toMatch(/username/);
  });

  it("rejects a missing or blank password, naming the problem", () => {
    const missing = parseCreateUserBody({ username: "alice", role: "user" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/password/);
    const blank = parseCreateUserBody({ username: "alice", password: "   ", role: "user" });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toMatch(/password/);
  });

  it("rejects a short password with the reused minimum and the actual length", () => {
    const eleven = parseCreateUserBody({ username: "alice", password: "x".repeat(11), role: "user" });
    expect(eleven.ok).toBe(false);
    if (!eleven.ok) {
      expect(eleven.error).toContain(String(MIN_PASSWORD_LENGTH));
      expect(eleven.error).toContain("11");
    }
  });

  it("accepts a password of exactly MIN_PASSWORD_LENGTH chars", () => {
    const parsed = parseCreateUserBody({
      username: "alice",
      password: "y".repeat(MIN_PASSWORD_LENGTH),
      role: "user",
    });
    expect(parsed.ok).toBe(true);
  });

  it("hashes exactly the raw password (leading/trailing spaces preserved)", () => {
    const padded = "  spaced secret  "; // 18 chars — valid length, kept raw
    const parsed = parseCreateUserBody({ username: "alice", password: padded, role: "user" });
    expect(parsed.ok && parsed.password).toBe(padded);
  });

  it("rejects any role other than exactly admin or user, naming the problem", () => {
    for (const role of ["root", "Admin", "", 1, null, undefined]) {
      const parsed = parseCreateUserBody({ username: "alice", password: "correct horse battery", role });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/role/);
    }
  });

  it("rejects non-object bodies (JSON array, null, primitives)", () => {
    for (const body of [null, [], "alice", 42]) {
      const parsed = parseCreateUserBody(body);
      expect(parsed.ok).toBe(false);
    }
  });
});

describe("parsePatchRoleBody (K6F4-03 PATCH /api/users/{id})", () => {
  it("accepts exactly admin or user", () => {
    expect(parsePatchRoleBody({ role: "admin" })).toEqual({ ok: true, role: "admin" });
    expect(parsePatchRoleBody({ role: "user" })).toEqual({ ok: true, role: "user" });
  });

  it("rejects any other role value, naming the problem", () => {
    for (const role of ["root", "Admin", "", 2, null, undefined]) {
      const parsed = parsePatchRoleBody({ role });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/role/);
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, [], "user", 42]) {
      expect(parsePatchRoleBody(body).ok).toBe(false);
    }
  });
});

describe("self-action lockout guards (K6F4-03)", () => {
  it("denies deleting your own account", () => {
    expect(checkDeleteTarget("u-admin", "u-admin")).toBe("self");
  });

  it("allows deleting another user's account", () => {
    expect(checkDeleteTarget("u-admin", "u-bob")).toBe("ok");
  });

  it("denies changing your own role (self-demote)", () => {
    expect(checkRoleChangeTarget("u-admin", "u-admin")).toBe("self");
  });

  it("allows changing another user's role", () => {
    expect(checkRoleChangeTarget("u-admin", "u-bob")).toBe("ok");
  });
});

describe("toSafeUserList (K6F4-03 response mapping)", () => {
  const rows: User[] = [
    {
      id: "u-1",
      username: "alice",
      passwordHash: "scrypt$16384$8$1$deadbeefcafe$0123456789abcdef",
      role: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: "u-2",
      username: "bob",
      passwordHash: "scrypt$16384$8$1$cafebabe0123$89abcdefdeadbeef",
      role: "user",
      createdAt: new Date("2026-02-02T00:00:00Z"),
    },
  ];

  it("maps rows to id/username/role/createdAt and never leaks passwordHash", () => {
    const mapped = toSafeUserList(rows);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toEqual({
      id: "u-1",
      username: "alice",
      role: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    for (const user of mapped) {
      expect("passwordHash" in user).toBe(false);
      expect(Object.keys(user).sort()).toEqual(["createdAt", "id", "role", "username"]);
    }
  });

  it("returns an empty list for no rows", () => {
    expect(toSafeUserList([])).toEqual([]);
  });
});
