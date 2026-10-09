import { describe, expect, it } from "vitest";
import {
  VARIABLE_NAME_PATTERN, findSecretEnvCollisions, findVariables, isValidVariableName,
  mergeVariables, parseTemplate, renderTemplateExpression, secretEnvName,
  type ResolvedVariables,
} from "./variables";

describe("VARIABLE_NAME_PATTERN / isValidVariableName", () => {
  it("accepts names that start with a letter or underscore", () => {
    expect(VARIABLE_NAME_PATTERN).toBe("[A-Za-z_][A-Za-z0-9_.-]{0,63}");
    for (const name of ["a", "_x", "baseUrl", "api.v1-token_2", "A".repeat(64)]) {
      expect(isValidVariableName(name)).toBe(true);
    }
  });

  it("rejects invalid names", () => {
    for (const name of ["", "1a", "-a", ".a", "bad name", "a$", "A".repeat(65), "a\n"]) {
      expect(isValidVariableName(name)).toBe(false);
    }
  });
});

describe("parseTemplate", () => {
  it("returns a single text segment when there are no placeholders", () => {
    expect(parseTemplate("https://x.test/a")).toEqual([{ type: "text", value: "https://x.test/a" }]);
  });

  it("returns no segments for empty text", () => {
    expect(parseTemplate("")).toEqual([]);
  });

  it("splits text and variables", () => {
    expect(parseTemplate("{{baseUrl}}/auth/login?x={{ id }}")).toEqual([
      { type: "var", name: "baseUrl" },
      { type: "text", value: "/auth/login?x=" },
      { type: "var", name: "id" },
    ]);
  });

  it("trims surrounding whitespace inside braces", () => {
    expect(parseTemplate("{{  token\t}}")).toEqual([{ type: "var", name: "token" }]);
  });

  it("keeps malformed placeholders as literal text", () => {
    expect(parseTemplate("{{}}")).toEqual([{ type: "text", value: "{{}}" }]);
    expect(parseTemplate("a{{bad name}}b")).toEqual([{ type: "text", value: "a{{bad name}}b" }]);
    expect(parseTemplate("{{x")).toEqual([{ type: "text", value: "{{x" }]);
    expect(parseTemplate("x}}")).toEqual([{ type: "text", value: "x}}" }]);
    expect(parseTemplate("{{1abc}}")).toEqual([{ type: "text", value: "{{1abc}}" }]);
  });

  it("recovers a valid placeholder after a malformed opener", () => {
    expect(parseTemplate("{{a {{b}}")).toEqual([
      { type: "text", value: "{{a " },
      { type: "var", name: "b" },
    ]);
    expect(parseTemplate("{{{x}}}")).toEqual([
      { type: "text", value: "{" },
      { type: "var", name: "x" },
      { type: "text", value: "}" },
    ]);
  });

  it("does not treat backslash as an escape", () => {
    expect(parseTemplate("\\{{x}}")).toEqual([
      { type: "text", value: "\\" },
      { type: "var", name: "x" },
    ]);
  });
});

describe("findVariables", () => {
  it("returns unique names in first-appearance order", () => {
    expect(findVariables("{{b}}{{a}}/{{ b }}{{bad name}}{{c}}")).toEqual(["b", "a", "c"]);
    expect(findVariables("plain")).toEqual([]);
  });
});

describe("mergeVariables", () => {
  it("lets scenario variables override environment variables by name", () => {
    const merged = mergeVariables(
      [
        { name: "baseUrl", value: "https://dev.test", secret: false },
        { name: "token", value: "env-token", secret: true },
      ],
      [
        { name: "baseUrl", value: "https://scenario.test", secret: false },
        { name: "extra", value: "1", secret: false },
      ],
    );
    expect(merged.get("baseUrl")).toEqual({ value: "https://scenario.test", secret: false });
    expect(merged.get("token")).toEqual({ value: "env-token", secret: true });
    expect(merged.get("extra")).toEqual({ value: "1", secret: false });
    expect(merged.size).toBe(3);
  });

  it("supports secrets without a client-side value", () => {
    const merged = mergeVariables([], [{ name: "token", secret: true }]);
    expect(merged.get("token")).toEqual({ secret: true });
  });

  it("override can change secrecy", () => {
    const merged = mergeVariables(
      [{ name: "token", value: "a", secret: false }],
      [{ name: "token", secret: true }],
    );
    expect(merged.get("token")).toEqual({ secret: true });
  });
});

describe("secretEnvName", () => {
  it("uppercases and replaces unsafe characters", () => {
    expect(secretEnvName("token")).toBe("K6FLOW_VAR_TOKEN");
    expect(secretEnvName("api.v1-key")).toBe("K6FLOW_VAR_API_V1_KEY");
    expect(secretEnvName("_x9")).toBe("K6FLOW_VAR__X9");
  });

  it("reports secret names that collide on the same env name", () => {
    const vars: ResolvedVariables = new Map([
      ["api.key", { secret: true }],
      ["api-key", { secret: true }],
      ["API_KEY", { secret: true }],
      ["api_key_public", { value: "x", secret: false }],
      ["other", { secret: true }],
      ["api_key", { value: "x", secret: false }],
    ]);
    expect(findSecretEnvCollisions(vars)).toEqual([
      { envName: "K6FLOW_VAR_API_KEY", names: ["API_KEY", "api-key", "api.key"] },
    ]);
  });

  it("reports no collision for distinct secrets", () => {
    const vars: ResolvedVariables = new Map([
      ["a", { secret: true }],
      ["b", { secret: true }],
    ]);
    expect(findSecretEnvCollisions(vars)).toEqual([]);
  });
});

describe("renderTemplateExpression", () => {
  const run = (expression: string, env: Record<string, string> = {}) =>
    new Function("__ENV", `return ${expression};`)(env);

  it("returns null for text without placeholders", () => {
    expect(renderTemplateExpression("plain {{bad name}}", new Map())).toBeNull();
  });

  it("inlines non-secret values as JSON string literals", () => {
    const vars: ResolvedVariables = new Map([["baseUrl", { value: "https://api.test", secret: false }]]);
    const out = renderTemplateExpression("{{baseUrl}}/auth/login", vars)!;
    expect(out.expression).toBe('"https://api.test" + "/auth/login"');
    expect(out.unknown).toEqual([]);
    expect(out.secretEnv).toEqual([]);
    expect(run(out.expression)).toBe("https://api.test/auth/login");
  });

  it("uses __ENV for secrets", () => {
    const vars: ResolvedVariables = new Map([["token", { secret: true }]]);
    const out = renderTemplateExpression("Bearer {{token}}", vars)!;
    expect(out.expression).toBe('"Bearer " + __ENV["K6FLOW_VAR_TOKEN"]');
    expect(out.secretEnv).toEqual(["K6FLOW_VAR_TOKEN"]);
    expect(run(out.expression, { K6FLOW_VAR_TOKEN: "s3cr3t" })).toBe("Bearer s3cr3t");
  });

  it("never inlines a secret value even when present", () => {
    const vars: ResolvedVariables = new Map([["token", { value: "LEAK", secret: true }]]);
    const out = renderTemplateExpression("{{token}}", vars)!;
    expect(out.expression).toBe('__ENV["K6FLOW_VAR_TOKEN"]');
    expect(out.expression).not.toContain("LEAK");
  });

  it("collects unknown variables and keeps their placeholder text", () => {
    const out = renderTemplateExpression("a{{missing}}b", new Map())!;
    expect(out.unknown).toEqual(["missing"]);
    expect(run(out.expression)).toBe("a{{missing}}b");
  });

  it("escapes hostile values and literal parts", () => {
    const hostile = "`${process.exit(1)}`'\"\\\n\r\u2028\u2029</script><script>alert(1)</script>";
    const vars: ResolvedVariables = new Map([["x", { value: hostile, secret: false }]]);
    const literal = "'); throw new Error('pwn'); ('`${1}`\"\n</script>";
    const out = renderTemplateExpression(`${literal}{{x}}${literal}`, vars)!;
    expect(out.expression).not.toContain("</script>");
    expect(out.expression).not.toContain("\n");
    expect(out.expression).not.toContain("\u2028");
    expect(run(out.expression)).toBe(`${literal}${hostile}${literal}`);
  });
});
