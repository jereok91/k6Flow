/**
 * Navigation entries of the sidebar, pinned without rendering React.
 *
 * The HAR import screen is reachable only from here, so losing its entry (or
 * giving it an empty label/icon) would silently orphan the route. The entries
 * are a plain array, so the smallest check is to read them directly.
 */

import { describe, expect, it } from "vitest";
import { navItems } from "./Sidebar";

describe("sidebar navigation entries", () => {
  it("links the HAR import screen with a label and an icon", () => {
    const entry = navItems.find((item) => item.path === "/import");

    expect(entry).toBeDefined();
    expect(entry?.label.trim().length).toBeGreaterThan(0);
    expect(entry?.icon.trim().length).toBeGreaterThan(0);
  });

  it("never repeats a path", () => {
    const paths = navItems.map((item) => item.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
