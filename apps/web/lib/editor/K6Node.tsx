"use client";

// K6F4-05b: Custom node component for React Flow.
// Renders node kind, label, and connection handles.

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { K6NodeData, NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "#6366f1", // indigo
  "http-request": "#22c55e",   // green
  "response-validation": "#f59e0b", // amber
  "user-pool": "#8b5cf6",      // violet
};

const KIND_ICONS: Record<NodeKind, string> = {
  "authentication": "🔐",
  "http-request": "🌐",
  "response-validation": "✓",
  "user-pool": "👥",
};

interface K6NodeProps {
  data: K6NodeData;
  selected?: boolean;
}

function K6NodeComponent({ data, selected }: K6NodeProps) {
  const color = KIND_COLORS[data.kind];
  const icon = KIND_ICONS[data.kind];

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        background: "#fff",
        border: `2px solid ${selected ? color : "#e5e7eb"}`,
        boxShadow: selected
          ? `0 0 0 2px ${color}40`
          : "0 1px 3px rgba(0,0,0,0.1)",
        minWidth: "150px",
        fontFamily: "system-ui, sans-serif",
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
          border: "2px solid #fff",
        }}
      />

      {/* Node content */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "18px" }}>{icon}</span>
        <div>
          <div
            style={{
              fontSize: "12px",
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {data.kind}
          </div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: "#111827" }}>
            {data.label}
          </div>
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
          border: "2px solid #fff",
        }}
      />
    </div>
  );
}

export const K6Node = memo(K6NodeComponent);
