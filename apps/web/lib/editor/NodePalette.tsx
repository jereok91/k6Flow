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
  "authentication": "var(--color-primary)",
  "http-request": "var(--color-secondary)",
  "response-validation": "var(--color-warning)",
  "user-pool": "var(--color-tertiary)",
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
        background: "var(--color-surface-container-lowest)",
        borderRight: "1px solid var(--color-surface-container)",
        width: "180px",
        overflowY: "auto",
      }}
    >
      <h3
        style={{
          fontSize: "11px",
          fontWeight: 500,
          color: "var(--color-on-surface-variant)",
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
              background: "var(--color-surface-container-low)",
              border: "1px solid var(--color-surface-container-high)",
              borderRadius: "8px",
              cursor: disabled ? "not-allowed" : "grab",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              color: disabled ? "var(--color-inactive)" : "var(--color-on-surface)",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!disabled) {
                e.currentTarget.style.borderColor = "var(--color-primary-container)";
                e.currentTarget.style.boxShadow = "var(--shadow-glow)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--color-surface-container-high)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ color: disabled ? "var(--color-inactive)" : KIND_COLORS[kind] }}
              aria-hidden="true"
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
