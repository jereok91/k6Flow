import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { reconcileThemePreference, resolveThemePreference, THEME_BOOTSTRAP } from "./theme-preference";

function environment(stored: string | null, system: boolean, brokenStorage = false) {
  const classes = new Set(["dark", "unrelated"]);
  const root = {
    classList: { contains: (name: string) => classes.has(name), remove: (...names: string[]) => names.forEach(name => classes.delete(name)), add: (name: string) => classes.add(name) },
    style: { colorScheme: "" },
  };
  const window = {
    get localStorage() {
      if (brokenStorage) throw new Error("blocked storage");
      return { getItem: () => stored };
    },
    matchMedia: () => ({ matches: system }),
  };
  return { window, document: { documentElement: root }, classes, root };
}

describe("theme preference and pre-paint bootstrap", () => {
  it.each([
    ["light", true, "light"], ["dark", false, "dark"],
    [null, true, "dark"], [null, false, "light"],
    ["invalid", false, "light"], ["LIGHT", true, "dark"],
  ] as const)("resolves %s with system dark=%s to %s", (stored, system, expected) => {
    const env = environment(stored, system);
    expect(resolveThemePreference(env.window)).toBe(expected);
    runInNewContext(THEME_BOOTSTRAP, env);
    expect(env.classes.has(expected)).toBe(true);
    expect(env.classes.has(expected === "dark" ? "light" : "dark")).toBe(false);
    expect(env.classes.has("unrelated")).toBe(true);
    expect(env.root.style.colorScheme).toBe(expected);
  });
  it.each([true, false])("uses system when storage access throws (dark=%s)", system => {
    const env = environment(null, system, true);
    runInNewContext(THEME_BOOTSTRAP, env);
    expect(env.root.style.colorScheme).toBe(system ? "dark" : "light");
  });
  it("guards getItem and matchMedia failures and unavailable browser APIs", () => {
    expect(resolveThemePreference()).toBe("dark");
    const window = { localStorage: { getItem: () => { throw new Error("denied"); } }, matchMedia: () => { throw new Error("unsupported"); } };
    expect(resolveThemePreference(window)).toBe("dark");
    const env = environment(null, false);
    runInNewContext(THEME_BOOTSTRAP, { ...env, window });
    expect(env.root.style.colorScheme).toBe("dark");
    expect(resolveThemePreference({})).toBe("dark");
  });
  it("honors a stored choice without consulting unavailable system APIs", () => {
    expect(resolveThemePreference({ localStorage: { getItem: () => "light" } })).toBe("light");
  });
  it.each([
    ["light", true, false, "light"],
    [null, false, false, "light"],
    [null, false, true, "light"],
    ["dark", false, false, "dark"],
  ] as const)("reconciles an SSR dark root when bootstrap is blocked (%s, system=%s, denied=%s)", (stored, system, denied, expected) => {
    const env = environment(stored, system, denied);
    // Do not execute bootstrap: this is the mount resolver, not a React mount test.
    expect(reconcileThemePreference(env.window, env.root)).toBe(expected);
    expect(env.root.style.colorScheme).toBe(expected);
    expect([...env.classes].sort()).toEqual([expected, "unrelated"].sort());
    // Replaying mount reconciliation (as in StrictMode) is idempotent.
    expect(reconcileThemePreference(env.window, env.root)).toBe(expected);
  });
  it("does not write an initial preference during mount reconciliation", () => {
    let writes = 0;
    const env = environment("light", true);
    const browser = {
      localStorage: { getItem: () => "light", setItem: () => { writes++; } },
    };
    expect(reconcileThemePreference(browser, env.root)).toBe("light");
    expect(writes).toBe(0);
  });
  it("uses the shared bootstrap in layout and keeps SSR children visible", () => {
    const layout = readFileSync("apps/web/app/layout.tsx", "utf8");
    const provider = readFileSync("apps/web/lib/theme/ThemeProvider.tsx", "utf8");
    expect(layout).toContain("__html: THEME_BOOTSTRAP");
    expect(provider).not.toContain("return null");
    expect(provider).toContain("reconcileThemePreference(window, root)");
    expect(provider).toContain("useCallback");
  });
});
