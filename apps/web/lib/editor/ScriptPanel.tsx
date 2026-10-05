"use client";

// Script panel to display generated K6 code from the current graph.

import { useMemo, useState } from "react";
import { translateToK6 } from "@k6flow/shared";
import { fromReactFlowGraph, type K6Node, type K6Edge } from "./mapping";

interface ScriptPanelProps {
  nodes: K6Node[];
  edges: K6Edge[];
  onClose: () => void;
}

export function ScriptPanel({ nodes, edges, onClose }: ScriptPanelProps) {
  const [copied, setCopied] = useState(false);
  const [vus, setVus] = useState(1);
  const [duration, setDuration] = useState("30s");

  const result = useMemo(() => {
    if (nodes.length === 0) {
      return { script: "// No hay nodos en el grafo", warnings: [], requiresFiles: [] };
    }
    const graph = fromReactFlowGraph(nodes, edges);
    return translateToK6(graph, { vus, duration });
  }, [nodes, edges, vus, duration]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(result.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = result.script;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([result.script], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scenario.js";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span className="material-symbols-outlined" style={{ fontSize: "20px", color: "var(--color-secondary)" }}>
            code
          </span>
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "var(--color-on-surface)" }}>
            Script K6
          </h3>
        </div>
        <button onClick={onClose} style={closeButtonStyle} aria-label="Close">
          <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>close</span>
        </button>
      </div>

      {/* Config row */}
      <div style={configRowStyle}>
        <div style={configGroupStyle}>
          <label style={labelStyle}>VUs</label>
          <input
            type="number"
            value={vus}
            onChange={(e) => setVus(Math.max(1, parseInt(e.target.value) || 1))}
            min={1}
            style={inputSmallStyle}
          />
        </div>
        <div style={configGroupStyle}>
          <label style={labelStyle}>Duración</label>
          <input
            type="text"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="30s"
            style={inputSmallStyle}
          />
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={handleCopy} style={actionButtonStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
            {copied ? "check" : "content_copy"}
          </span>
          <span>{copied ? "Copiado" : "Copiar"}</span>
        </button>
        <button onClick={handleDownload} style={actionButtonStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>download</span>
          <span>Descargar</span>
        </button>
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div style={warningsStyle}>
          {result.warnings.map((w, i) => (
            <div key={i} style={warningItemStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: "14px", color: "#f59e0b" }}>
                warning
              </span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Required files */}
      {result.requiresFiles.length > 0 && (
        <div style={filesInfoStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: "14px", color: "var(--color-secondary)" }}>
            attach_file
          </span>
          <span>Archivos requeridos: {result.requiresFiles.join(", ")}</span>
        </div>
      )}

      {/* Script content */}
      <div style={codeContainerStyle}>
        <pre style={codeStyle}>
          <code>{result.script}</code>
        </pre>
      </div>
    </div>
  );
}

// Styles
const panelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: "45%",
  minHeight: "250px",
  maxHeight: "60%",
  background: "var(--color-surface-container-lowest)",
  borderTop: "1px solid var(--color-surface-container-high)",
  display: "flex",
  flexDirection: "column",
  zIndex: 100,
  fontFamily: "var(--font-sans)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px",
  borderRadius: "4px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const configRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
  padding: "8px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
  background: "var(--color-surface-container-low)",
};

const configGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--color-on-surface-variant)",
};

const inputSmallStyle: React.CSSProperties = {
  width: "70px",
  padding: "4px 8px",
  fontSize: "12px",
  fontFamily: "var(--font-mono)",
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "4px",
  color: "var(--color-on-surface)",
};

const actionButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  padding: "4px 10px",
  fontSize: "12px",
  background: "var(--color-surface-container)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "6px",
  color: "var(--color-on-surface)",
  cursor: "pointer",
};

const warningsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  padding: "8px 16px",
  background: "rgba(245, 158, 11, 0.1)",
  borderBottom: "1px solid rgba(245, 158, 11, 0.3)",
};

const warningItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "12px",
  color: "#f59e0b",
};

const filesInfoStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 16px",
  fontSize: "12px",
  color: "var(--color-secondary)",
  background: "rgba(76, 215, 246, 0.05)",
  borderBottom: "1px solid rgba(76, 215, 246, 0.2)",
};

const codeContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "0",
};

const codeStyle: React.CSSProperties = {
  margin: 0,
  padding: "16px",
  fontSize: "12px",
  lineHeight: 1.5,
  fontFamily: "var(--font-mono)",
  color: "var(--color-on-surface)",
  whiteSpace: "pre",
  tabSize: 2,
};
