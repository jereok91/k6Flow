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
  "response-validation": "#f59e0b",
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
    <div className="p-space-md bg-surface-container-lowest border-r border-surface-container w-[180px] overflow-y-auto">
      <h3 className="text-label-code-sm text-on-surface-variant uppercase tracking-wider mb-space-md">
        Nodes
      </h3>

      <div className="flex flex-col gap-space-sm">
        {NODE_KINDS.map((kind) => (
          <div
            key={kind}
            draggable={!disabled}
            onDragStart={(e) => onDragStart(e, kind)}
            className={`
              p-space-sm bg-surface-container-low border border-surface-container-high rounded-lg
              flex items-center gap-space-sm text-body-sm text-on-surface
              transition-all duration-150
              ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-grab hover:border-primary hover:shadow-glow"}
            `}
          >
            <span 
              className="material-symbols-outlined text-[18px]"
              style={{ color: KIND_COLORS[kind] }}
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
