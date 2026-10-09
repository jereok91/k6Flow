export type Theme = "dark" | "light";

type PreferenceWindow = {
  localStorage?: { getItem: (key: string) => string | null };
  matchMedia?: (query: string) => { matches: boolean };
};

// Self-contained so the exact same resolver can run before React or hydration.
export function resolveThemePreference(browser?: PreferenceWindow): Theme {
  try {
    const stored = browser?.localStorage?.getItem("k6flow-theme");
    if (stored === "dark" || stored === "light") return stored;
  } catch { /* Storage may be denied; system preference still works. */ }
  try {
    if (browser?.matchMedia) {
      return browser.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch { /* Unsupported system preference API: use the default. */ }
  return "dark";
}

type ThemeRoot = {
  classList: { contains: (name: string) => boolean; remove: (...names: string[]) => void; add: (name: string) => void };
  style: { colorScheme: string };
};

// Reconcile after hydration without persisting the server's default.
export function reconcileThemePreference(browser: PreferenceWindow, root: ThemeRoot): Theme {
  // The SSR dark class is not proof that the inline bootstrap executed.
  const theme = resolveThemePreference(browser);
  root.classList.remove("dark", "light");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  return theme;
}

// Deployments enforcing an external CSP must authorize these exact inline bytes
// with their script hash/nonce policy. Do not weaken that policy to unsafe-inline.
export const THEME_BOOTSTRAP = `(() => {
  const theme = (${resolveThemePreference.toString()})(window);
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
  root.style.colorScheme = theme;
})();`;
