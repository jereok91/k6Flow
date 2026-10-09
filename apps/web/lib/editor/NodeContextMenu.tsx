"use client";

import { useEffect, useRef } from "react";
import type { NodeAction } from "./node-interactions";

export function NodeContextMenu({ x, y, hasNodes, canPaste, onAction, onClose }: {
  x: number; y: number; hasNodes: boolean; canPaste: boolean;
  onAction: (action: NodeAction) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as globalThis.Node)) onClose();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  const items: { action: NodeAction; label: string; hint: string; disabled: boolean }[] = [
    { action: "copy", label: "Copiar", hint: "Ctrl/⌘ C", disabled: !hasNodes },
    { action: "paste", label: "Pegar", hint: "Ctrl/⌘ V", disabled: !canPaste },
    { action: "duplicate", label: "Duplicar", hint: "Ctrl/⌘ D", disabled: !hasNodes },
    { action: "toggle", label: "Activar / desactivar", hint: "", disabled: !hasNodes },
    { action: "delete", label: "Eliminar", hint: "Supr / ⌫", disabled: !hasNodes },
  ];
  return (
    <div ref={menu} role="menu" aria-label="Acciones de nodos"
      onContextMenu={e => e.preventDefault()}
      onKeyDown={e => {
        if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose(); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault(); e.stopPropagation();
          const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}
      style={{ position: "fixed", left: Math.max(0, Math.min(x, window.innerWidth - 260)),
        top: Math.max(0, Math.min(y, window.innerHeight - 230)), zIndex: 100,
        width: 250, padding: 6, borderRadius: 8, background: "var(--color-surface-container-low)",
        border: "1px solid var(--color-surface-container-high)", boxShadow: "var(--shadow-modal)" }}>
      {items.map(item => <button key={item.action} role="menuitem" disabled={item.disabled}
        onClick={() => onAction(item.action)}
        style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "8px 10px",
          color: "var(--color-on-surface)", opacity: item.disabled ? 0.45 : 1, borderRadius: 4 }}>
        <span>{item.label}</span><kbd style={{ fontSize: 11 }}>{item.hint}</kbd>
      </button>)}
    </div>
  );
}
