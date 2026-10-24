/**
 * `useSearchParams()` opts a page out of static prerendering: without a Suspense
 * boundary anywhere above it, `next build` fails with "useSearchParams() should be
 * wrapped in a suspense boundary". That failure only appears at build time, so this
 * test pins the requirement on the source instead of waiting for a broken build.
 *
 * The boundary may live in the page itself, in a `layout.tsx`/`template.tsx` of its
 * directory, or in one of theirs up to `app/` — exactly where React would find it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = import.meta.dirname;

/** Files React can use to wrap the pages below them. */
const BOUNDARY_FILES = new Set(["page.tsx", "layout.tsx", "template.tsx"]);

const USES_HOOK = /useSearchParams\s*\(/;
const HAS_BOUNDARY = /<Suspense\b/;

export interface SourceFile {
  path: string;
  source: string;
}

/**
 * Drops comments, so markup quoted in prose cannot satisfy the check, while
 * leaving strings untouched.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * Pages that call `useSearchParams()` without a Suspense boundary above them.
 * A boundary in the page's own directory covers it, as does one in any ancestor
 * directory, because that is how the App Router nests layouts.
 */
export function pagesMissingBoundary(files: SourceFile[]): string[] {
  const analysed = files
    .filter((file) => BOUNDARY_FILES.has(basename(file.path)))
    .map((file) => ({ path: file.path, source: stripComments(file.source) }));

  const coveredDirs = new Set(
    analysed.filter((file) => HAS_BOUNDARY.test(file.source)).map((file) => dirname(file.path)),
  );

  return analysed
    .filter((file) => basename(file.path) === "page.tsx" && USES_HOOK.test(file.source))
    .filter((file) => {
      for (let dir = dirname(file.path); ; dir = dirname(dir)) {
        if (coveredDirs.has(dir)) return false;
        if (dirname(dir) === dir) return true;
      }
    })
    .map((file) => file.path);
}

function sourceFiles(dir: string): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (BOUNDARY_FILES.has(entry)) {
      found.push({ path, source: readFileSync(path, "utf8") });
    }
  }
  return found;
}

describe("the boundary rule", () => {
  const HOOK = `const params = useSearchParams();`;
  const page = (dir: string, body: string) => ({ path: join(dir, "page.tsx"), source: body });

  it("accepts a page that renders its own boundary", () => {
    const path = join(APP_DIR, "a", "page.tsx");
    expect(pagesMissingBoundary([{ path, source: `<Suspense><Inner /></Suspense>${HOOK}` }])).toEqual([]);
  });

  it("accepts a page covered by a layout above it", () => {
    const dir = join(APP_DIR, "a", "b");
    expect(
      pagesMissingBoundary([
        { path: join(APP_DIR, "a", "layout.tsx"), source: `<Suspense>{children}</Suspense>` },
        page(dir, HOOK),
      ]),
    ).toEqual([]);
  });

  it("reports a page with no boundary above it", () => {
    const path = join(APP_DIR, "a", "b", "page.tsx");
    expect(pagesMissingBoundary([page(dirname(path), HOOK)])).toEqual([path]);
  });

  it("is not satisfied by a boundary mentioned in a comment", () => {
    const path = join(APP_DIR, "a", "page.tsx");
    const source = `// we used to have <Suspense> here\n/* <Suspense> */\n${HOOK}`;
    expect(pagesMissingBoundary([{ path, source }])).toEqual([path]);
  });

  it("ignores pages that never read the query string", () => {
    const path = join(APP_DIR, "a", "page.tsx");
    expect(pagesMissingBoundary([{ path, source: `export default function P() { return null; }` }])).toEqual([]);
  });
});

describe("app router pages that read the query string", () => {
  it("all have a Suspense boundary above them", () => {
    const offenders = pagesMissingBoundary(sourceFiles(APP_DIR)).map((path) => relative(APP_DIR, path));
    expect(offenders).toEqual([]);
  });
});
