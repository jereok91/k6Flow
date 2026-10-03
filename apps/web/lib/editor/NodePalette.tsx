"use client";

// K6F4-05b: Node palette for dragging new nodes onto the canvas.

import { type DragEvent } from "react";
import { NODE_KINDS, getNodeLabel, type NodeKind } from "./mapping";

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "#6366f1",
  "http-request": "#22c55e",
  "response-validation": "#f59e0b",
  "user-pool": "#8b5cf6",
};

const KIND_ICONS: Record<NodeKind, string> = {
  "authentication": "🔐",
  "http-request": "🌐",
  "response-validation": "✓",
  "user-pool": "👥",
};

interface NodePaletteProps {
  disabled?: boolean;
}

export function NodePalette({ disabled }: NodePaletteProps) {
  const onDragStart = (event: DragEvent<HTMLDivElement>, kind: NodeKind) => {
    event.dataTransfer.setData("application/k6flow-node-kind", kind);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      style={{
        padding: "16px",
        background: "#f9fafb",
        borderRight: "1px solid #e5e7eb",
        width: "200px",
        overflowY: "auto",
      }}
    >
      <h3
        style={{
          fontSize: "12px",
          fontWeight: 600,
          color: "#6b7280",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "12px",
        }}
      >
        Nodes
      </h3>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {NODE_KINDS.map((kind) => (
          <div
            key={kind}
            draggable={!disabled}
            onDragStart={(e) => onDragStart(e, kind)}
            style={{
              padding: "10px 12px",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: "6px",
              cursor: disabled ? "not-allowed" : "grab",
              opacity: disabled ? 0.5 : 1,
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              fontFamily: "system-ui, sans-serif",
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!disabled) {
                e.currentTarget.style.borderColor = KIND_COLORS[kind];
                e.currentTarget.style.boxShadow = `0 0 0 1px ${KIND_COLORS[kind]}40`;
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "#e5e7eb";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "4px",
                background: `${KIND_COLORS[kind]}20`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "14px",
              }}
            >
              {KIND_ICONS[kind]}
            </span>
            <span style={{ color: "#374151" }}>{getNodeLabel(kind)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
