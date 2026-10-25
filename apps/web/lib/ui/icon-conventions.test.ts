import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// UI convention guard: every Material Symbols glyph in the app is decorative
// (announced as nothing) or labelled, has an explicit size from the documented
// scale, and carries no inline font sizing.

const WEB_ROOT = join(import.meta.dirname, "..", "..");
/** Documented icon scale (px). Anything else drifts from the design system. */
const ALLOWED_ICON_SIZES = new Set([12, 16, 18, 20, 24, 32, 40, 48]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const files = [...sourceFiles(join(WEB_ROOT, "app")), ...sourceFiles(join(WEB_ROOT, "lib"))];

function iconSpans(text: string): string[] {
  return [...text.matchAll(/<span\b[^>]*material-symbols-outlined[^>]*>/g)].map((match) => match[0]);
}

const spans = files.flatMap((file) =>
  iconSpans(readFileSync(file, "utf8")).map((tag) => ({ file: relative(WEB_ROOT, file), tag })),
);

describe("icon conventions", () => {
  it("finds the icon spans it is meant to guard", () => {
    expect(spans.length).toBeGreaterThan(100);
  });

  it("announces every icon as decorative or labelled", () => {
    const unlabelled = spans
      .filter(({ tag }) => !tag.includes('aria-hidden="true"') && !tag.includes("aria-label="))
      .map(({ file, tag }) => `${file}: ${tag.slice(0, 90)}`);

    expect(unlabelled).toEqual([]);
  });

  it("sizes every icon with a class from the scale", () => {
    const wrong = spans.flatMap(({ file, tag }) => {
      const size = /text-\[(\d+)px\]/.exec(tag);
      if (size === null) return [`${file}: sin clase de tamaño → ${tag.slice(0, 90)}`];
      if (!ALLOWED_ICON_SIZES.has(Number(size[1]))) {
        return [`${file}: tamaño ${size[1]}px fuera de la escala → ${tag.slice(0, 90)}`];
      }
      return [];
    });

    expect(wrong).toEqual([]);
  });

  it("keeps font sizing out of inline styles", () => {
    const inline = spans
      .filter(({ tag }) => tag.includes("fontSize"))
      .map(({ file, tag }) => `${file}: ${tag.slice(0, 90)}`);

    expect(inline).toEqual([]);
  });
});
