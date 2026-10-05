"use client";

// K6F4-05b: Node palette for dragging new nodes onto the canvas.

import { type DragEvent } from "react";
import { NODE_KINDS, getNodeLabel, type NodeKind } from "./mapping";

const KIND_ICONS: Record<NodeKind, string> = {
  "authentication": "key",
  "http-request": "language",
  "response-validation": "check_circle",
  "user-pool": "group",
};

const KIND_COLORS: Record<NodeKind, string> = {
  "authentication": "#d2bbff",
  "http-request": "#4cd7f6",
  "response-validation": "#f59e0b",
  "user-pool": "#d0bcff",
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
        padding: "12px",
        background: "#0a0e14",
        borderRight: "1px solid #1c2026",
        width: "180px",
        overflowY: "auto",
      }}
    >
      <h3
        style={{
          fontSize: "11px",
          fontWeight: 500,
          color: "#ccc3d8",
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
              background: "#181c22",
              border: "1px solid #262a31",
              borderRadius: "8px",
              cursor: disabled ? "not-allowed" : "grab",
              opacity: disabled ? 0.5 : 1,
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              color: "#dfe2eb",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!disabled) {
                e.currentTarget.style.borderColor = "#7c3aed";
                e.currentTarget.style.boxShadow = "0 0 12px rgba(124, 58, 237, 0.35)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "#262a31";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "18px", color: KIND_COLORS[kind] }}
            >
              {KIND_ICONS[kind]}
            </span>
            <span>{getNodeLabel(kind)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
