"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "../theme";

const navItems = [
  { path: "/", label: "Inicio", icon: "grid_view" },
  { path: "/scenarios", label: "Escenarios", icon: "account_tree" },
  { path: "/recordings", label: "Grabaciones", icon: "fiber_manual_record" },
  { path: "/recorder", label: "Grabar", icon: "videocam" },
  { path: "/editor", label: "Editor", icon: "edit_square" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

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
        width: "256px",
        backgroundColor: "var(--color-surface-container-lowest)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        boxShadow: "0 1px 8px rgba(0,0,0,0.3)",
      }}
    >
      {/* Logo */}
      <div
        style={{
          height: "64px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
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
            }}
          >
            <span style={{ color: "var(--color-on-primary-container)", fontWeight: "bold", fontSize: "14px" }}>
              k6
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-on-surface)" }}>
              K6Flow
            </span>
            <span style={{ fontSize: "11px", color: "var(--color-secondary)" }}>v2.4.0</span>
          </div>
        </Link>
        <button
          type="button"
          style={{
            padding: "4px",
            color: "var(--color-on-surface-variant)",
            background: "none",
            border: "none",
            cursor: "pointer",
            borderRadius: "8px",
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>dock_to_right</span>
        </button>
      </div>

      {/* Workspace indicator */}
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

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "4px 12px", display: "flex", flexDirection: "column", gap: "4px", overflowY: "auto" }}>
        {navItems.map((item) => (
          <Link
            key={item.path}
            href={item.path}
            className={`nav-link ${isActive(item.path) ? "nav-link-active" : ""}`}
            style={{ textDecoration: "none" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {/* Theme toggle */}
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

        {/* User */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px",
            backgroundColor: "var(--color-surface-container-low)",
            borderRadius: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
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
              <span className="material-symbols-outlined" style={{ color: "var(--color-secondary)", fontSize: "18px" }}>
                person
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--color-on-surface)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Usuario
              </span>
              <span style={{ fontSize: "11px", color: "var(--color-on-surface-variant)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                DevOps Engineer
              </span>
            </div>
          </div>
          <button
            type="button"
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
        </div>
      </div>
    </aside>
  );
}
