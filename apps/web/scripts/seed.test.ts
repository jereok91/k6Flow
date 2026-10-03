import { describe, expect, it } from "vitest";
import { validateSeedEnv } from "./seed";

describe("validateSeedEnv (K6F4-01b admin seed CLI)", () => {
  it("missing ADMIN_USERNAME → error naming the variable", () => {
    const result = validateSeedEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ADMIN_USERNAME");
  });

  it("blank ADMIN_USERNAME → error naming the variable", () => {
    const result = validateSeedEnv({ ADMIN_USERNAME: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ADMIN_USERNAME");
  });

  it("missing ADMIN_PASSWORD → error naming the variable", () => {
    const result = validateSeedEnv({ ADMIN_USERNAME: "admin" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ADMIN_PASSWORD");
  });

  it("password shorter than 12 chars → error mentioning the minimum", () => {
    const result = validateSeedEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "short" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/12/);
  });

  it("valid env → ok with trimmed username and raw password", () => {
    const result = validateSeedEnv({
      ADMIN_USERNAME: "  admin  ",
      ADMIN_PASSWORD: "correct horse battery staple",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.username).toBe("admin");
      expect(result.password).toBe("correct horse battery staple");
    }
  });
});
