"use client";

// K6F4-05c: Base config panel component for node parameter editing.
// Wraps node-specific forms with consistent styling.

import type { ReactNode } from "react";
import type { NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "#6366f1",
  "http-request": "#22c55e",
  "response-validation": "#f59e0b",
  "user-pool": "#8b5cf6",
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
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div style={{ marginBottom: "16px" }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <p style={hintStyle}>{hint}</p>}
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      style={{ ...inputStyle, resize: "vertical" }}
    />
  );
}

// Styles
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "60px",
  right: "16px",
  width: "320px",
  maxHeight: "calc(100vh - 80px)",
  background: "#fff",
  borderRadius: "8px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  zIndex: 1000,
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, sans-serif",
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
  color: "#111827",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: "16px",
  color: "#6b7280",
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
  color: "#374151",
  marginBottom: "4px",
};

const hintStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "#6b7280",
  marginTop: "4px",
  marginBottom: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  outline: "none",
  boxSizing: "border-box",
};
