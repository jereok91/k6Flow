import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  environmentVariables,
  environments,
  scenarioVariables,
  scenarios,
  sessions,
  users,
} from "./schema";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const sqlText = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

function sqlCols(
  table:
    | typeof users
    | typeof sessions
    | typeof scenarios
    | typeof environments
    | typeof environmentVariables
    | typeof scenarioVariables,
) {
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

  // k6flow-variables V-T2
  it("environments has expected columns, owner cascade and unique(owner_id, name)", () => {
    expect(getTableName(environments)).toBe("environments");
    expect(sqlCols(environments)).toEqual({
      id: "id",
      ownerId: "owner_id",
      name: "name",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
    expect(environments.name.notNull).toBe(true);
    expect(sqlText).toMatch(
      /CONSTRAINT "environments_owner_id_name_unique" UNIQUE\("owner_id","name"\)/,
    );
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "environments_owner_id_users_id_fk" FOREIGN KEY \("owner_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/,
    );
  });

  it("environment_variables has expected columns, cascade and unique(environment_id, name)", () => {
    expect(getTableName(environmentVariables)).toBe("environment_variables");
    expect(sqlCols(environmentVariables)).toEqual({
      id: "id",
      environmentId: "environment_id",
      name: "name",
      value: "value",
      secret: "secret",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
    expect(environmentVariables.secret.notNull).toBe(true);
    expect(environmentVariables.secret.default).toBe(false);
    expect(sqlText).toMatch(
      /CONSTRAINT "environment_variables_environment_id_name_unique" UNIQUE\("environment_id","name"\)/,
    );
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "environment_variables_environment_id_environments_id_fk" FOREIGN KEY \("environment_id"\) REFERENCES "public"\."environments"\("id"\) ON DELETE cascade/,
    );
  });

  it("scenario_variables has expected columns, cascade and unique(scenario_id, name)", () => {
    expect(getTableName(scenarioVariables)).toBe("scenario_variables");
    expect(sqlCols(scenarioVariables)).toEqual({
      id: "id",
      scenarioId: "scenario_id",
      name: "name",
      value: "value",
      secret: "secret",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
    expect(scenarioVariables.secret.default).toBe(false);
    expect(sqlText).toMatch(
      /CONSTRAINT "scenario_variables_scenario_id_name_unique" UNIQUE\("scenario_id","name"\)/,
    );
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "scenario_variables_scenario_id_scenarios_id_fk" FOREIGN KEY \("scenario_id"\) REFERENCES "public"\."scenarios"\("id"\) ON DELETE cascade/,
    );
  });

  it("0007_variables is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 7, tag: "0007_variables" });
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
