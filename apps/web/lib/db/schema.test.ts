import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { scenarios, sessions, users } from "./schema";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const sqlText = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

function sqlCols(table: typeof users | typeof sessions | typeof scenarios) {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([tsKey, col]) => [tsKey, col.name]),
  );
}

describe("db schema", () => {
  it("users has expected columns (snake_case in DB)", () => {
    expect(getTableName(users)).toBe("users");
    expect(sqlCols(users)).toEqual({
      id: "id",
      username: "username",
      passwordHash: "password_hash",
      role: "role",
      createdAt: "created_at",
    });
    expect(users.username.notNull).toBe(true);
    // drizzle-orm 0.45.3 columns do not expose `.unique`; UNIQUE is asserted
    // against the generated migration SQL, the authoritative artifact.
    expect(sqlText).toMatch(
      /CONSTRAINT "users_username_unique" UNIQUE\("username"\)/,
    );
  });

  it("sessions has expected columns", () => {
    expect(getTableName(sessions)).toBe("sessions");
    expect(sqlCols(sessions)).toEqual({
      token: "token",
      userId: "user_id",
      createdAt: "created_at",
      expiresAt: "expires_at",
    });
  });

  it("scenarios has expected columns", () => {
    expect(getTableName(scenarios)).toBe("scenarios");
    expect(sqlCols(scenarios)).toEqual({
      id: "id",
      ownerId: "owner_id",
      name: "name",
      graph: "graph",
      folderId: "folder_id",
      isFavorite: "is_favorite",
      vus: "vus",
      durationSeconds: "duration_seconds",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
  });

  // The role CHECK is asserted against the generated migration SQL, which is
  // the authoritative artifact. The TS schema carries the same constraint via
  // drizzle's check(); a purely type-level assertion could not prove rejection
  // of invalid values, so the SQL text is the executable proof.
  it("role CHECK allows admin/user and rejects others", () => {
    expect(sqlText.length).toBeGreaterThan(0);
    // Exact clause: IN-list is exhaustive, so any other value is rejected.
    expect(sqlText).toMatch(
      /CONSTRAINT "users_role_check" CHECK \("users"\."role" IN \('admin', 'user'\)\)/,
    );
    // Parse the IN-list: allowed set must be exactly {admin, user}, so any
    // other value is rejected by construction.
    const inList =
      sqlText.match(/CHECK \("users"\."role" IN \(([^)]*)\)\)/)?.[1] ?? "";
    const roleValues = [...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(roleValues)).toEqual(new Set(["admin", "user"]));
  });
});
