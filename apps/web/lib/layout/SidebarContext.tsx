"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const STORAGE_KEY = "k6flow-sidebar-collapsed";

interface SidebarContextType {
  collapsed: boolean;
  ready: boolean;
  toggleCollapsed: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

// Read initial value synchronously on client
function getInitialCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const [ready, setReady] = useState(false);

  // Mark as ready after hydration
  useEffect(() => {
    setReady(true);
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  const toggleCollapsed = () => setCollapsed((prev) => !prev);

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
