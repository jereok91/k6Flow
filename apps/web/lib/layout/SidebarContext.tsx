"use client";

import { createContext, useCallback, useContext, useRef, useState, useEffect, type ReactNode } from "react";
import { readSidebarPreference, writeSidebarPreference } from "./sidebar-preference";

interface SidebarContextType {
  collapsed: boolean;
  ready: boolean;
  toggleCollapsed: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export function SidebarProvider({ children }: { children: ReactNode }) {
  // Match SSR on the first client render; read preferences only after hydration.
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const currentCollapsed = useRef(false);

  useEffect(() => {
    const resolved = readSidebarPreference(window);
    currentCollapsed.current = resolved;
    setCollapsed(resolved);
    setReady(true);
    // Do not overwrite a stored preference with the initial SSR default.
  }, []);

  const toggleCollapsed = useCallback(() => {
    const next = !currentCollapsed.current;
    currentCollapsed.current = next;
    setCollapsed(next);
    // Keep side effects out of state updaters, which StrictMode may replay.
    writeSidebarPreference(window, next);
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed, ready, toggleCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return context;
}
