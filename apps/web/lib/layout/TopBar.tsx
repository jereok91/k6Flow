"use client";

import Link from "next/link";

export function TopBar() {
  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: "256px",
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
      }}
    >
      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", color: "var(--color-on-surface-variant)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>k6flow</span>
        <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>chevron_right</span>
        <span style={{ color: "var(--color-on-surface)", fontWeight: 500 }}>Plataforma</span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Link href="/recorder" className="btn-primary">
          <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>videocam</span>
          <span>Grabar</span>
        </Link>
        <Link href="/editor" className="btn-secondary">
          <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>edit_square</span>
          <span>Editor</span>
        </Link>
      </div>
    </header>
  );
}
