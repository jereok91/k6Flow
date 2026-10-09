// Pure parts of the variables store. DB-backed paths (queries, transactions)
// follow the repository convention of being proven against the real stack;
// the ownership decisions, masking and merge rules they rely on are tested here.

import { describe, expect, it } from "vitest";
import {
  classifyEnvironmentAccess,
  classifyScenarioAccess,
  isUniqueViolation,
  maskVariables,
  mergeVariablesForRun,
  storeFailureResponse,
  toExportVariables,
} from "./store";

const user = { id: "u1", role: "user" as const };
const other = { id: "u2", role: "user" as const };
const admin = { id: "a1", role: "admin" as const };

describe("maskVariables", () => {
  it("returns plaintext only for non-secrets and never a value field for secrets", () => {
    const masked = maskVariables([
      { name: "baseUrl", value: "https://a", secret: false },
      { name: "token", value: "s3cret", secret: true },
      { name: "empty", value: "", secret: true },
    ]);
    expect(masked).toEqual([
      { name: "baseUrl", value: "https://a", secret: false },
      { name: "token", secret: true, hasValue: true },
      { name: "empty", secret: true, hasValue: false },
    ]);
    expect(masked[1]).not.toHaveProperty("value");
    expect(JSON.stringify(masked)).not.toContain("s3cret");
  });
});

describe("toExportVariables", () => {
  it("exports secrets as {name, secret:true} only", () => {
    const exported = toExportVariables([
      { name: "baseUrl", value: "https://a", secret: false },
      { name: "token", value: "s3cret", secret: true },
    ]);
    expect(exported).toEqual([
      { name: "baseUrl", value: "https://a", secret: false },
      { name: "token", secret: true },
    ]);
    expect(JSON.stringify(exported)).not.toContain("s3cret");
    expect(JSON.stringify(exported)).not.toContain("hasValue");
  });
});

describe("classifyEnvironmentAccess", () => {
  it("is strictly owner-only (admins included)", () => {
    expect(classifyEnvironmentAccess(undefined, user)).toBe("not-found");
    expect(classifyEnvironmentAccess({ ownerId: "u1" }, user)).toBe("ok");
    expect(classifyEnvironmentAccess({ ownerId: "u1" }, other)).toBe("forbidden");
    expect(classifyEnvironmentAccess({ ownerId: "u1" }, admin)).toBe("forbidden");
  });
});

describe("classifyScenarioAccess", () => {
  it("reuses scenario access rules (owner or admin)", () => {
    expect(classifyScenarioAccess(undefined, user)).toBe("not-found");
    expect(classifyScenarioAccess({ ownerId: "u1" }, user)).toBe("ok");
    expect(classifyScenarioAccess({ ownerId: "u1" }, other)).toBe("forbidden");
    expect(classifyScenarioAccess({ ownerId: "u1" }, admin)).toBe("ok");
  });
});

describe("mergeVariablesForRun", () => {
  it("lets scenario variables override environment variables by name, with full values", () => {
    const merged = mergeVariablesForRun(
      [
        { name: "baseUrl", value: "https://env", secret: false },
        { name: "token", value: "env-secret", secret: true },
        { name: "onlyEnv", value: "e", secret: false },
      ],
      [
        { name: "token", value: "scn-secret", secret: true },
        { name: "baseUrl", value: "https://scn", secret: false },
        { name: "onlyScn", value: "s", secret: true },
      ],
    );
    expect(merged).toEqual([
      { name: "baseUrl", value: "https://scn", secret: false },
      { name: "token", value: "scn-secret", secret: true },
      { name: "onlyEnv", value: "e", secret: false },
      { name: "onlyScn", value: "s", secret: true },
    ]);
  });

  it("lets the scenario change the secret flag", () => {
    expect(
      mergeVariablesForRun([{ name: "a", value: "1", secret: true }], [{ name: "a", value: "2", secret: false }]),
    ).toEqual([{ name: "a", value: "2", secret: false }]);
  });
});

describe("storeFailureResponse", () => {
  it("maps failures to 404/403/409/422 with structured errors", async () => {
    expect(storeFailureResponse({ ok: false, reason: "not-found" }, "Environment").status).toBe(404);
    expect(storeFailureResponse({ ok: false, reason: "forbidden" }, "Environment").status).toBe(403);
    expect(storeFailureResponse({ ok: false, reason: "conflict" }, "Environment").status).toBe(409);
    const errors = [{ index: 0, field: "name" as const, code: "invalid-name" as const, message: "bad" }];
    const response = storeFailureResponse({ ok: false, reason: "invalid", errors }, "Environment");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid variables", errors });
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505, directly or as a cause", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
