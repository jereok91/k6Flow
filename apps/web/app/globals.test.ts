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
  "text-success",
  "text-warning",
  "text-danger",
  "text-inactive",
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

  it("generates semantic foreground utilities using runtime variables", () => {
    for (const name of ["success", "warning", "danger", "inactive"]) {
      expect(ruleBody(`text-${name}`)).toContain(`var(--color-${name})`);
    }
  });
});

const rawCss = readFileSync(globalsPath, "utf8");
const theme = rawCss.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const dark = rawCss.match(/:root,\s*\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const light = rawCss.match(/\.light\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
describe("runtime theme token structure", () => {
  it("registers semantic utilities with unlayered dark/light overrides", () => {
    for (const token of ["success", "warning", "danger", "inactive"]) {
      for (const block of [theme, dark, light]) expect(block).toMatch(new RegExp(`--color-${token}:\\s*#[0-9a-f]{6};`));
    }
    expect(rawCss.indexOf(":root,")).toBeLessThan(rawCss.indexOf("@layer base"));
    expect(rawCss.indexOf(".light {")).toBeLessThan(rawCss.indexOf("@layer base"));
  });
  it("preserves theme-independent fixed tokens and existing fonts", () => {
    expect(theme).toContain("--color-primary-fixed:");
    expect(light).not.toMatch(/--color-\S*fixed/);
    expect(theme).toContain("--font-sans: Geist");
    expect(theme).toContain("--font-mono: JetBrains Mono");
  });
  it("provides reduced motion and visible theme-control focus", () => {
    expect(rawCss).toContain("prefers-reduced-motion: reduce");
    expect(rawCss).toContain(".theme-control:focus-visible");
    expect(rawCss).toContain("min-height: 44px");
  });
  it("uses readable semantic foregrounds in light mode", () => {
    const luminance = (hex: string) => {
      const rgb = hex.match(/\w\w/g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const background = luminance(light.match(/--color-surface-container-high:\s*#([0-9a-f]{6})/)![1]);
    for (const name of ["success", "warning", "danger", "inactive"]) {
      const foreground = luminance(light.match(new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`))![1]);
      expect((background + 0.05) / (foreground + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
