// Verifies that the design tokens are registered with Tailwind v4 via the
// `@theme` block in globals.css, so token utilities (bg-surface-container,
// gap-space-md, text-body-sm, ...) are generated, resolve to the runtime
// `--color-*` variables, and the unlayered `.light` overrides still win.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const globalsPath = path.join(here, "globals.css");

const CANDIDATES = [
  "bg-surface-container",
  "text-on-surface-variant",
  "border-outline-variant",
  "gap-space-md",
  "text-body-sm",
  "px-gutter-desktop",
  "bg-primary-fixed",
  "font-mono",
  "rounded-lg",
  "shadow-glow",
];

let css = "";

/** Return the declaration body of the first rule whose selector is `.cls`. */
function ruleBody(cls: string): string {
  const escaped = cls.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const match = css.match(new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : "";
}

beforeAll(async () => {
  const source = readFileSync(globalsPath, "utf8")
    // Disable filesystem scanning; feed only the fixture candidates.
    .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
  const input = `${source}\n@source inline("${CANDIDATES.join(" ")}");\n`;
  const result = await postcss([tailwind({ optimize: false })]).process(input, {
    from: globalsPath,
  });
  css = result.css;
}, 60_000);

describe("globals.css — Tailwind v4 @theme tokens", () => {
  it.each([
    ["bg-surface-container", "background-color"],
    ["text-on-surface-variant", "color"],
    ["border-outline-variant", "border-color"],
    ["gap-space-md", "gap"],
    ["text-body-sm", "font-size"],
    ["px-gutter-desktop", "padding-inline"],
    ["bg-primary-fixed", "background-color"],
    ["shadow-glow", "--tw-shadow"],
  ])("generates %s", (cls, prop) => {
    expect(ruleBody(cls)).toContain(prop);
  });

  it("color utilities reference var(--color-*) instead of hex literals", () => {
    for (const cls of [
      "bg-surface-container",
      "text-on-surface-variant",
      "border-outline-variant",
    ]) {
      const body = ruleBody(cls);
      expect(body).toMatch(/var\(--color-[a-z-]+\)/);
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("spacing, text and shadow utilities reference theme variables", () => {
    expect(ruleBody("gap-space-md")).toContain("var(--spacing-space-md)");
    expect(ruleBody("px-gutter-desktop")).toContain("var(--spacing-gutter-desktop)");
    const text = ruleBody("text-body-sm");
    expect(text).toContain("var(--text-body-sm)");
    expect(text).toContain("--text-body-sm--line-height");
    // Tailwind inlines shadow values; the theme-dependent color must stay a
    // runtime variable so the light theme override applies.
    expect(ruleBody("shadow-glow")).toContain("var(--shadow-glow-color)");
    expect(ruleBody("shadow-glow")).not.toMatch(/rgba\(/);
  });

  it("declares theme colors without circular references", () => {
    expect(css).not.toMatch(/--color-([a-z-]+)\s*:\s*var\(--color-\1\)/);
  });

  it("keeps .light overrides unlayered, after the theme layer", () => {
    const light = css.match(/(^|\n)\.light\s*\{([^}]*)\}/);
    expect(light).not.toBeNull();
    expect(light![2]).toMatch(/--color-surface-container:\s*#f1f5f9/);
    expect(light![2]).toMatch(/--shadow-glow-color:/);

    // Unlayered rules beat any @layer rule regardless of order; also assert
    // the .light block is not nested inside an @layer.
    const lightIndex = css.indexOf(light![0]);
    const before = css.slice(0, lightIndex);
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);

    const themeIndex = css.indexOf("@layer theme");
    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(themeIndex).toBeLessThan(lightIndex);
  });
});
