"use client";

import { useRef, useState } from "react";
import type { K6Node, K6Edge } from "./mapping";
import { copySelection, pasteClipboard, deleteSelection, toggleDisabled, type Clipboard, type NodeAction } from "./node-interactions";

/** Keeps the clipboard in this editor instance, never on the OS clipboard or in storage. */
export function useNodeInteractions({ nodes, edges, flow, readOnly, onNodesChange, onEdgesChange, onNodeSelect }: {
  nodes: K6Node[];
  edges: K6Edge[];
  flow: string;
  readOnly: boolean;
  onNodesChange: (nodes: K6Node[]) => void;
  onEdgesChange: (edges: K6Edge[]) => void;
  onNodeSelect?: (node: K6Node | null) => void;
}) {
  const clipboard = useRef<Clipboard | null>(null);
  const [message, setMessage] = useState("");
  const pasteCount = useRef(0);
  const canPaste = clipboard.current?.flow === flow;

  const execute = (action: NodeAction, ids?: string[]) => {
    if (readOnly) return;
    const current = ids ? nodes.map(n => ({ ...n, selected: ids.includes(n.id) })) : nodes;
    if (action === "copy") {
      clipboard.current = copySelection(current, edges, flow);
      pasteCount.current = 0;
      setMessage(clipboard.current ? "Nodos copiados." : "Selecciona al menos un nodo.");
      return;
    }
    if (action !== "paste" && !current.some(n => n.selected)) {
      setMessage("Selecciona al menos un nodo.");
      return;
    }
    const result = action === "toggle"
      ? { nodes: toggleDisabled(current, current.filter(n => n.selected).map(n => n.id)), edges }
      : action === "delete" ? deleteSelection(current, edges)
      : pasteClipboard(current, edges,
          action === "duplicate" ? copySelection(current, edges, flow) : clipboard.current,
          flow, undefined, action === "paste" ? { x: 30 * (pasteCount.current + 1), y: 30 * (pasteCount.current + 1) } : undefined);
    if ("error" in result && result.error) {
      setMessage(result.error);
      return;
    }
    if (action === "paste") pasteCount.current += 1;
    onNodesChange(result.nodes);
    onEdgesChange(result.edges);
    const selected = result.nodes.filter(n => n.selected);
    onNodeSelect?.(selected.length === 1 ? selected[0] : null);
    setMessage(({ paste: "Nodos pegados.", duplicate: "Nodos duplicados.", delete: "Nodos eliminados.", toggle: "Estado actualizado." } as const)[action]);
  };
  return { execute, message, canPaste };
}
