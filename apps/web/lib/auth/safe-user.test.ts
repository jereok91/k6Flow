import { describe, expect, it } from "vitest";
import type { User } from "../db/schema";
import { toSafeUser } from "./safe-user";

// K6F4-02a: toSafeUser is a pure mapping — no DB, no IO.
const userRow: User = {
  id: "u1",
  username: "alice",
  passwordHash: "scrypt$16384$8$1$deadbeefcafe$0123456789abcdef",
  role: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("toSafeUser (K6F4-02a)", () => {
  it("strips passwordHash and preserves public fields", () => {
    const safe = toSafeUser(userRow);
    expect(safe).toEqual({
      id: "u1",
      username: "alice",
      role: "user",
      createdAt: userRow.createdAt,
    });
    expect(safe).not.toHaveProperty("passwordHash");
  });

  it("preserves the admin role", () => {
    expect(toSafeUser({ ...userRow, role: "admin" }).role).toBe("admin");
  });
});
