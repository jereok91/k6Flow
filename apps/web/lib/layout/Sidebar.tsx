"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";
import { useSidebar } from "./SidebarContext";

interface User {
  id: string;
  username: string;
  role: string;
}

const navItems = [
  { path: "/", label: "Inicio", icon: "grid_view" },
  { path: "/scenarios", label: "Escenarios", icon: "account_tree" },
  { path: "/recordings", label: "Grabaciones", icon: "fiber_manual_record" },
  { path: "/recorder", label: "Grabar", icon: "videocam" },
  { path: "/editor", label: "Editor", icon: "edit_square" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const { collapsed, ready, toggleCollapsed } = useSidebar();
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch current user
  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpen]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  return (
    <aside
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        height: "100%",
        width: collapsed ? "72px" : "256px",
        backgroundColor: "var(--color-surface-container-lowest)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        boxShadow: "0 1px 8px rgba(0,0,0,0.3)",
        transition: ready ? "width 0.2s ease" : "none",
        overflow: "hidden",
      }}
    >
      {/* Logo */}
      <div
        style={{
          height: "64px",
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          padding: collapsed ? "0 8px" : "0 16px",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "8px", textDecoration: "none" }}>
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              backgroundColor: "var(--color-primary-container)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span style={{ color: "var(--color-on-primary-container)", fontWeight: "bold", fontSize: "14px" }}>
              k6
            </span>
          </div>
          {!collapsed && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-on-surface)" }}>
                K6Flow
              </span>
              <span style={{ fontSize: "11px", color: "var(--color-secondary)" }}>v2.4.0</span>
            </div>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            style={{
              padding: "4px",
              color: "var(--color-on-surface-variant)",
              background: "none",
              border: "none",
              cursor: "pointer",
              borderRadius: "8px",
            }}
            title="Colapsar sidebar"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>dock_to_right</span>
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <div style={{ padding: "0 8px 8px" }}>
          <button
            type="button"
            onClick={toggleCollapsed}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "8px",
              color: "var(--color-on-surface-variant)",
              background: "var(--color-surface-container-low)",
              border: "none",
              cursor: "pointer",
              borderRadius: "8px",
            }}
            title="Expandir sidebar"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>chevron_right</span>
          </button>
        </div>
      )}

      {/* Workspace indicator */}
      {!collapsed && (
        <div style={{ padding: "8px 12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 8px",
              backgroundColor: "var(--color-surface-container-low)",
              borderRadius: "8px",
            }}
          >
            <span style={{ fontSize: "11px", color: "var(--color-on-surface-variant)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Workspace
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--color-secondary)" }} />
              <span style={{ fontSize: "12px", color: "var(--color-on-surface)", fontWeight: 500 }}>Local</span>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav style={{ flex: 1, padding: collapsed ? "4px 8px" : "4px 12px", display: "flex", flexDirection: "column", gap: "4px", overflowY: "auto" }}>
        {navItems.map((item) => (
          <Link
            key={item.path}
            href={item.path}
            className={`nav-link ${isActive(item.path) ? "nav-link-active" : ""}`}
            style={{ 
              textDecoration: "none",
              justifyContent: collapsed ? "center" : "flex-start",
              padding: collapsed ? "10px" : undefined,
            }}
            title={collapsed ? item.label : undefined}
          >
            <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: collapsed ? "8px" : "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {/* Theme toggle */}
        {collapsed ? (
          <button
            type="button"
            onClick={toggleTheme}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px",
              backgroundColor: "var(--color-surface-container-low)",
              borderRadius: "8px",
              border: "none",
              cursor: "pointer",
              color: "var(--color-on-surface-variant)",
            }}
            title={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          >
            <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>
              {theme === "dark" ? "dark_mode" : "light_mode"}
            </span>
          </button>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 8px",
              backgroundColor: "var(--color-surface-container-low)",
              borderRadius: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-on-surface-variant)" }}>
              <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>
                {theme === "dark" ? "dark_mode" : "light_mode"}
              </span>
              <span style={{ fontSize: "12px" }}>
                {theme === "dark" ? "Tema oscuro" : "Tema claro"}
              </span>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              style={{
                width: "36px",
                height: "20px",
                backgroundColor: theme === "dark" ? "var(--color-primary-container)" : "var(--color-surface-container-high)",
                borderRadius: "10px",
                border: "none",
                cursor: "pointer",
                position: "relative",
                transition: "background-color 0.2s",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: "3px",
                  left: theme === "dark" ? "19px" : "3px",
                  width: "14px",
                  height: "14px",
                  backgroundColor: theme === "dark" ? "var(--color-on-primary-container)" : "var(--color-on-surface)",
                  borderRadius: "50%",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                }}
              />
            </button>
          </div>
        )}

        {/* User */}
        <div
          ref={menuRef}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "space-between",
            padding: "8px",
            backgroundColor: "var(--color-surface-container-low)",
            borderRadius: "8px",
          }}
        >
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              minWidth: 0,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            title={collapsed ? user?.username || "Usuario" : undefined}
          >
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                backgroundColor: "var(--color-surface-container-high)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span style={{ color: "var(--color-secondary)", fontSize: "14px", fontWeight: 600 }}>
                {user?.username?.charAt(0).toUpperCase() || "U"}
              </span>
            </div>
            {!collapsed && (
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, textAlign: "left" }}>
                <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--color-on-surface)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {user?.username || "Usuario"}
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-on-surface-variant)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {user?.role || ""}
                </span>
              </div>
            )}
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              style={{
                color: "var(--color-on-surface-variant)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>more_vert</span>
            </button>
          )}

          {/* Dropdown menu */}
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: collapsed ? "0" : undefined,
                right: collapsed ? undefined : "0",
                marginBottom: "4px",
                minWidth: "160px",
                backgroundColor: "var(--color-surface-container-high)",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                overflow: "hidden",
                zIndex: 100,
              }}
            >
              <button
                type="button"
                onClick={handleLogout}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 12px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-error)",
                  fontSize: "13px",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--color-surface-container-highest)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>logout</span>
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
