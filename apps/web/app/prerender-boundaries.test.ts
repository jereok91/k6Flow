/**
 * `useSearchParams()` opts a page out of static prerendering: without a Suspense
 * boundary above it, `next build` fails with "useSearchParams() should be wrapped
 * in a suspense boundary". That failure only appears at build time, so this test
 * pins the requirement on the source instead of waiting for a broken build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = import.meta.dirname;

function pageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...pageFiles(path));
    } else if (entry === "page.tsx") {
      found.push(path);
    }
  }
  return found;
}

describe("app router pages that read the query string", () => {
  it("wrap useSearchParams in a Suspense boundary", () => {
    const offenders = pageFiles(APP_DIR)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /useSearchParams\s*\(/.test(source) && !/<Suspense\b/.test(source);
      })
      .map((file) => relative(APP_DIR, file));

    expect(offenders).toEqual([]);
  });
});
