"use client";

// K6F4-05c: Base config panel component for node parameter editing.
// Wraps node-specific forms with consistent styling.

import type { ReactNode } from "react";
import type { NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "#d2bbff",
  "http-request": "#4cd7f6",
  "response-validation": "#f59e0b",
  "user-pool": "#d0bcff",
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

// Dark theme styles
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "16px",
  right: "16px",
  width: "320px",
  maxHeight: "calc(100vh - 100px)",
  background: "#181c22",
  border: "1px solid #262a31",
  borderRadius: "12px",
  boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
  zIndex: 1000,
  display: "flex",
  flexDirection: "column",
  fontFamily: "Geist, system-ui, sans-serif",
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
  color: "#dfe2eb",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: "16px",
  color: "#ccc3d8",
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
  color: "#ccc3d8",
  marginBottom: "6px",
};

const hintStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "#958da1",
  marginTop: "4px",
  marginBottom: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "13px",
  fontFamily: "JetBrains Mono, monospace",
  background: "#0a0e14",
  border: "1px solid #4a4455",
  borderRadius: "8px",
  color: "#dfe2eb",
  outline: "none",
  boxSizing: "border-box",
};
