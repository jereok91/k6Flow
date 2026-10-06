"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { SidebarProvider, useSidebar } from "./SidebarContext";
import { TopBar } from "./TopBar";

interface MainLayoutProps {
  children: ReactNode;
}

function LayoutContent({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <TopBar />
      <main
        style={{
          paddingLeft: collapsed ? "72px" : "256px",
          paddingTop: "64px",
          minHeight: "100vh",
          transition: "padding-left 0.2s ease",
        }}
      >
        <div className="w-full px-6 py-6">{children}</div>
      </main>
    </div>
  );
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <SidebarProvider>
      <LayoutContent>{children}</LayoutContent>
    </SidebarProvider>
  );
}
