"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { reconcileThemePreference, type Theme } from "./theme-preference";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Identical server/first-client render; CSS already follows the pre-paint root.
  const [theme, setThemeState] = useState<Theme>("dark");
  const currentTheme = useRef<Theme>("dark");

  useEffect(() => {
    const root = document.documentElement;
    const resolved = reconcileThemePreference(window, root);
    currentTheme.current = resolved;
    setThemeState(resolved);
    // Reading/reconciling must not persist the initial default over a preference.
  }, []);

  const setTheme = useCallback((next: Theme) => {
    currentTheme.current = next;
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(next);
    root.style.colorScheme = next;
    setThemeState(next);
    try { window.localStorage.setItem("k6flow-theme", next); }
    catch { /* Theme still works for this session when storage is unavailable. */ }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(currentTheme.current === "dark" ? "light" : "dark");
  }, [setTheme]);
  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
