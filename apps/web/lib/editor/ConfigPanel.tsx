"use client";

// K6F4-05c: Base config panel component for node parameter editing.
// Wraps node-specific forms with consistent styling.

import type { ReactNode } from "react";
import type { NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "var(--color-primary)",
  "http-request": "var(--color-secondary)",
  "response-validation": "#f59e0b",
  "user-pool": "var(--color-tertiary)",
};

interface ConfigPanelProps {
  kind: NodeKind;
  title: string;
  children: ReactNode;
  onClose: () => void;
}

export function ConfigPanel({ kind, title, children, onClose }: ConfigPanelProps) {
  const color = KIND_COLORS[kind];

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{ ...headerStyle, borderBottomColor: color }}>
        <h3 style={titleStyle}>{title}</h3>
        <button onClick={onClose} style={closeButtonStyle} aria-label="Close">
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={contentStyle}>{children}</div>
    </div>
  );
}

// Shared form components
export function FormField({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: boolean;
}) {
  return (
    <div style={{ marginBottom: "16px" }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <p style={{ ...hintStyle, color: error ? "#ef4444" : undefined }}>{hint}</p>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={inputStyle}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={inputStyle}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      style={{ 
        ...inputStyle, 
        resize: "vertical",
        fontFamily: mono ? "'Fira Code', 'Monaco', 'Consolas', monospace" : undefined,
        fontSize: mono ? "13px" : undefined,
        lineHeight: mono ? "1.5" : undefined,
      }}
    />
  );
}

// Theme-aware styles using CSS variables
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "16px",
  right: "16px",
  width: "320px",
  maxHeight: "calc(100vh - 100px)",
  background: "var(--color-surface-container-low)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "12px",
  boxShadow: "var(--shadow-modal)",
  zIndex: 1000,
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  borderBottom: "2px solid",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: "16px",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px",
};

const contentStyle: React.CSSProperties = {
  padding: "16px",
  overflowY: "auto",
  flex: 1,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--color-on-surface-variant)",
  marginBottom: "6px",
};

const hintStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--color-outline)",
  marginTop: "4px",
  marginBottom: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "13px",
  fontFamily: "var(--font-mono)",
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  color: "var(--color-on-surface)",
  outline: "none",
  boxSizing: "border-box",
};
