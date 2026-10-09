"use client";

// k6flow-variables V-T4: environment dropdown shown next to "Ejecutar" in the editor.
// The selection is persisted by `useSelectedEnvironment` and passed to the run.
// Styled like the editor top bar `.btn-secondary` controls (padding, 12px radius,
// outline-variant border) using the theme CSS variables from app/globals.css.

import Link from "next/link";
import type { EnvironmentSummary } from "./use-variables";

interface EnvironmentSelectorProps {
  environments: readonly EnvironmentSummary[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
}

export function EnvironmentSelector({
  environments,
  selectedId,
  onChange,
  loading,
  error,
  disabled,
}: EnvironmentSelectorProps) {
  const isDisabled = disabled || loading;
  return (
    <div style={wrapperStyle} title={error ? `Entornos: ${error}` : "Entorno de ejecución"}>
      <div style={{ ...selectFrameStyle, ...(error ? { borderColor: "var(--color-error)" } : null) }}>
        <span className="material-symbols-outlined" style={leadingIconStyle} aria-hidden="true">
          layers
        </span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          disabled={isDisabled}
          aria-label="Entorno de ejecución"
          style={{ ...selectStyle, ...(isDisabled ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
        >
          <option value="" style={optionStyle}>{loading ? "Cargando..." : "Sin entorno"}</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id} style={optionStyle}>
              {env.name}
            </option>
          ))}
        </select>
      </div>
      <Link
        href="/environments"
        className="btn-secondary"
        style={manageLinkStyle}
        title="Gestionar entornos"
        aria-label="Gestionar entornos"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
          tune
        </span>
      </Link>
    </div>
  );
}

const wrapperStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "4px",
};

// Same box as `.btn-secondary` (globals.css): 1px outline-variant border, 12px radius,
// space-sm vertical padding, transparent background.
const selectFrameStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  padding: "0 4px 0 12px",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "12px",
  background: "transparent",
  color: "var(--color-on-surface)",
};

const leadingIconStyle: React.CSSProperties = {
  fontSize: 16,
  color: "var(--color-on-surface-variant)",
};

const selectStyle: React.CSSProperties = {
  maxWidth: "160px",
  padding: "8px 4px",
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--color-on-surface)",
  font: "inherit",
  fontSize: "13px",
  cursor: "pointer",
};

// Native dropdown list: keep options readable on the dark theme.
const optionStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  color: "var(--color-on-surface)",
};

const manageLinkStyle: React.CSSProperties = {
  justifyContent: "center",
  padding: "8px",
  color: "var(--color-on-surface-variant)",
};
