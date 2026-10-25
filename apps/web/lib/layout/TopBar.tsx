"use client";

import Link from "next/link";
import { useSidebar } from "./SidebarContext";
import { useTheme } from "../theme";

export function TopBar() {
  const { collapsed, ready } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: collapsed ? "72px" : "256px",
        right: 0,
        height: "64px",
        backgroundColor: "var(--color-surface-container-lowest)",
        backdropFilter: "blur(12px)",
        zIndex: 40,
        boxShadow: "0 1px 8px rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        transition: ready ? "left 0.2s ease" : "none",
      }}
    >
      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", color: "var(--color-on-surface-variant)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>k6flow</span>
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true" >chevron_right</span>
        <span style={{ color: "var(--color-on-surface)", fontWeight: 500 }}>Plataforma</span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button
          type="button"
          className="btn-secondary theme-control"
          aria-label="Tema oscuro"
          aria-pressed={theme === "dark"}
          title={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          onClick={toggleTheme}
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[20px]" >
            {theme === "dark" ? "dark_mode" : "light_mode"}
          </span>
        </button>
        <Link href="/recorder" className="btn-primary">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true" >videocam</span>
          <span>Grabar</span>
        </Link>
        <Link href="/editor" className="btn-secondary">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true" >edit_square</span>
          <span>Editor</span>
        </Link>
      </div>
    </header>
  );
}
