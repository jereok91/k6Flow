"use client";

// K6F4-05b: Custom node component for React Flow.
// Renders node kind, label, and connection handles.

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { K6NodeData, NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "var(--color-primary)",
  "http-request": "var(--color-secondary)",
  "response-validation": "var(--color-warning)",
  "user-pool": "var(--color-tertiary)",
};

const KIND_ICONS: Record<NodeKind, string> = {
  "authentication": "key",
  "http-request": "language",
  "response-validation": "check_circle",
  "user-pool": "group",
};

interface K6NodeProps {
  data: K6NodeData;
  selected?: boolean;
}

function K6NodeComponent({ data, selected }: K6NodeProps) {
  const color = data.disabled ? "var(--color-inactive)" : KIND_COLORS[data.kind];
  const icon = KIND_ICONS[data.kind];

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        background: "var(--color-surface-container-low)",
        border: `2px ${data.disabled ? "dashed" : "solid"} ${selected ? color : "var(--color-surface-container-high)"}`,
        boxShadow: selected
          ? "var(--shadow-glow)"
          : "0 1px 3px rgba(0,0,0,0.3)",
        minWidth: "150px",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Input handle */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: color,
          width: "10px",
          height: "10px",
          border: "2px solid var(--color-surface-container-low)",
        }}
      />

      {/* Node content */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          className="material-symbols-outlined text-[20px]"
          style={{ color }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--color-on-surface-variant)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {data.kind}
          </div>
          <div style={{ 
            fontSize: "13px", 
            fontWeight: 500, 
            color: "var(--color-on-surface)",
            maxWidth: "180px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {data.label}
          </div>
          {data.disabled && <span style={{ fontSize: 11, color: "var(--color-inactive)" }}>Desactivado</span>}
        </div>
      </div>

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: color,
          width: "10px",
          height: "10px",
          border: "2px solid var(--color-surface-container-low)",
        }}
      />
    </div>
  );
}

export const K6Node = memo(K6NodeComponent);
