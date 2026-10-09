const STORAGE_KEY = "k6flow-sidebar-collapsed";

type SidebarWindow = {
  localStorage?: {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
  };
};

export function readSidebarPreference(browser?: SidebarWindow): boolean {
  try {
    return browser?.localStorage?.getItem?.(STORAGE_KEY) === "true";
  } catch {
    return false; // Storage can be denied even when accessing the property.
  }
}

export function writeSidebarPreference(browser: SidebarWindow | undefined, collapsed: boolean): void {
  try {
    browser?.localStorage?.setItem?.(STORAGE_KEY, String(collapsed));
  } catch { /* Keep the session choice even when persistence is unavailable. */ }
}
