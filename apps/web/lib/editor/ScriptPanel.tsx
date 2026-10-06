"use client";

// Script panel to display generated K6 code from the current graph.
// Improved layout with better spacing and visual hierarchy.

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
  const [showConfig, setShowConfig] = useState(false);

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

  const lineCount = result.script.split("\n").length;

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={headerLeftStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: "20px", color: "var(--color-primary)" }}>
            code
          </span>
          <h3 style={titleStyle}>Script K6</h3>
          <span style={badgeStyle}>{lineCount} líneas</span>
        </div>

        <div style={headerActionsStyle}>
          {/* Config toggle */}
          <button
            onClick={() => setShowConfig(!showConfig)}
            style={{
              ...iconButtonStyle,
              background: showConfig ? "var(--color-primary-container)" : "transparent",
              color: showConfig ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)",
            }}
            title="Configuración"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>tune</span>
          </button>

          {/* Copy */}
          <button onClick={handleCopy} style={iconButtonStyle} title={copied ? "¡Copiado!" : "Copiar"}>
            <span className="material-symbols-outlined" style={{ fontSize: "18px", color: copied ? "var(--color-primary)" : undefined }}>
              {copied ? "check" : "content_copy"}
            </span>
          </button>

          {/* Download */}
          <button onClick={handleDownload} style={iconButtonStyle} title="Descargar">
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>download</span>
          </button>

          {/* Divider */}
          <div style={dividerStyle} />

          {/* Close */}
          <button onClick={onClose} style={iconButtonStyle} title="Cerrar">
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>close</span>
          </button>
        </div>
      </div>

      {/* Config panel (collapsible) */}
      {showConfig && (
        <div style={configPanelStyle}>
          <div style={configGroupStyle}>
            <label style={labelStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>group</span>
              VUs
            </label>
            <input
              type="number"
              value={vus}
              onChange={(e) => setVus(Math.max(1, parseInt(e.target.value) || 1))}
              min={1}
              style={inputStyle}
            />
          </div>
          <div style={configGroupStyle}>
            <label style={labelStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>timer</span>
              Duración
            </label>
            <input
              type="text"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="30s"
              style={inputStyle}
            />
          </div>
          <div style={configHintStyle}>
            Ejemplos: 30s, 1m, 5m30s
          </div>
        </div>
      )}

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div style={warningsContainerStyle}>
          <div style={warningsHeaderStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>warning</span>
            <span>{result.warnings.length} advertencia{result.warnings.length > 1 ? "s" : ""}</span>
          </div>
          <div style={warningsListStyle}>
            {result.warnings.map((w, i) => (
              <div key={i} style={warningItemStyle}>• {w}</div>
            ))}
          </div>
        </div>
      )}

      {/* Required files */}
      {result.requiresFiles.length > 0 && (
        <div style={filesContainerStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>attach_file</span>
          <span>Archivos necesarios:</span>
          <div style={filesListStyle}>
            {result.requiresFiles.map((f, i) => (
              <span key={i} style={fileChipStyle}>{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* Code content */}
      <div style={codeContainerStyle}>
        <div style={lineNumbersStyle}>
          {result.script.split("\n").map((_, i) => (
            <div key={i} style={lineNumberStyle}>{i + 1}</div>
          ))}
        </div>
        <pre style={codeStyle}>
          <code>{result.script}</code>
        </pre>
      </div>
    </div>
  );
}

// === Styles ===

const panelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: "45%",
  minHeight: "280px",
  maxHeight: "60%",
  background: "var(--color-surface-container-lowest)",
  borderTop: "1px solid var(--color-outline-variant)",
  display: "flex",
  flexDirection: "column",
  zIndex: 100,
  fontFamily: "var(--font-sans)",
  boxShadow: "0 -4px 12px rgba(0,0,0,0.1)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
  background: "var(--color-surface-container-low)",
  flexShrink: 0,
};

const headerLeftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const badgeStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "10px",
  background: "var(--color-surface-container-high)",
  color: "var(--color-on-surface-variant)",
};

const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const iconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "6px",
  borderRadius: "6px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 0.15s, color 0.15s",
};

const dividerStyle: React.CSSProperties = {
  width: "1px",
  height: "20px",
  background: "var(--color-outline-variant)",
  margin: "0 4px",
};

const configPanelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "24px",
  padding: "12px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
  background: "var(--color-surface-container)",
  flexShrink: 0,
};

const configGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "12px",
  color: "var(--color-on-surface-variant)",
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "80px",
  padding: "6px 10px",
  fontSize: "13px",
  fontFamily: "var(--font-mono)",
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "6px",
  color: "var(--color-on-surface)",
};

const configHintStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--color-on-surface-variant)",
  opacity: 0.7,
  marginLeft: "auto",
};

const warningsContainerStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "rgba(245, 158, 11, 0.08)",
  borderBottom: "1px solid rgba(245, 158, 11, 0.2)",
  flexShrink: 0,
};

const warningsHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "12px",
  fontWeight: 600,
  color: "#d97706",
  marginBottom: "6px",
};

const warningsListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const warningItemStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#b45309",
  paddingLeft: "22px",
};

const filesContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "10px 16px",
  fontSize: "12px",
  color: "var(--color-on-surface-variant)",
  background: "rgba(76, 215, 246, 0.05)",
  borderBottom: "1px solid rgba(76, 215, 246, 0.15)",
  flexShrink: 0,
};

const filesListStyle: React.CSSProperties = {
  display: "flex",
  gap: "6px",
  flexWrap: "wrap",
};

const fileChipStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "4px",
  background: "var(--color-secondary-container)",
  color: "var(--color-on-secondary-container)",
  fontFamily: "var(--font-mono)",
};

const codeContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  display: "flex",
  minHeight: 0,
};

const lineNumbersStyle: React.CSSProperties = {
  padding: "16px 0",
  background: "var(--color-surface-container-low)",
  borderRight: "1px solid var(--color-surface-container)",
  userSelect: "none",
  flexShrink: 0,
};

const lineNumberStyle: React.CSSProperties = {
  padding: "0 12px",
  fontSize: "12px",
  lineHeight: "18px",
  fontFamily: "var(--font-mono)",
  color: "var(--color-on-surface-variant)",
  opacity: 0.5,
  textAlign: "right",
  minWidth: "32px",
};

const codeStyle: React.CSSProperties = {
  margin: 0,
  padding: "16px",
  fontSize: "12px",
  lineHeight: "18px",
  fontFamily: "var(--font-mono)",
  color: "var(--color-on-surface)",
  whiteSpace: "pre",
  tabSize: 2,
  flex: 1,
};
