import { describe, expect, it } from "vitest";
import { readSidebarPreference, writeSidebarPreference } from "./sidebar-preference";

const key = "k6flow-sidebar-collapsed";

describe("sidebar storage preferences", () => {
  it.each([["true", true], ["false", false], [null, false], ["invalid", false]] as const)(
    "reads %s as %s without writing the initial default", (stored, expected) => {
      let writes = 0;
      const browser = { localStorage: {
        getItem: (name: string) => { expect(name).toBe(key); return stored; },
        setItem: () => { writes++; },
      } };
      expect(readSidebarPreference(browser)).toBe(expected);
      expect(readSidebarPreference(browser)).toBe(expected);
      expect(writes).toBe(0);
    },
  );
  it("guards denied storage access and storage methods", () => {
    const denied = { get localStorage(): never { throw new Error("denied"); } };
    const broken = { localStorage: {
      getItem: (): never => { throw new Error("denied read"); },
      setItem: (): never => { throw new Error("denied write"); },
    } };
    for (const browser of [undefined, {}, denied, broken]) {
      expect(readSidebarPreference(browser)).toBe(false);
      expect(() => writeSidebarPreference(browser, true)).not.toThrow();
      expect(() => writeSidebarPreference(browser, false)).not.toThrow();
    }
  });
  it("persists explicit changes under the existing key", () => {
    const writes: [string, string][] = [];
    const browser = { localStorage: { setItem: (name: string, value: string) => writes.push([name, value]) } };
    writeSidebarPreference(browser, true);
    writeSidebarPreference(browser, false);
    expect(writes).toEqual([[key, "true"], [key, "false"]]);
  });
});
