"use client";

// Panel to display history of K6 test executions.

import { useState } from "react";

export interface RunHistoryEntry {
  runId: string;
  scenarioName: string;
  startedAt: Date;
  completedAt?: Date;
  status: "completed" | "failed" | "stopped" | "running";
  vus: number;
  duration: string;
  iterations: number;
  avgDuration?: number;
  errorRate?: number;
}

interface RunHistoryPanelProps {
  history: RunHistoryEntry[];
  onViewRun?: (runId: string) => void;
  onClose: () => void;
}

export function RunHistoryPanel({ history, onViewRun, onClose }: RunHistoryPanelProps) {
  const [filter, setFilter] = useState<"all" | "completed" | "failed">("all");

  const filteredHistory = history.filter(entry => {
    if (filter === "all") return true;
    if (filter === "completed") return entry.status === "completed";
    if (filter === "failed") return entry.status === "failed" || entry.status === "stopped";
    return true;
  });

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("es", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "#10b981";
      case "failed": return "#ef4444";
      case "stopped": return "#6b7280";
      case "running": return "#f59e0b";
      default: return "#6b7280";
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "completed": return "Completado";
      case "failed": return "Fallido";
      case "stopped": return "Detenido";
      case "running": return "Ejecutando";
      default: return status;
    }
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "16px" }}>📊</span>
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
            Historial de Ejecuciones
          </h3>
          <span style={{ 
            fontSize: "11px", 
            color: "var(--color-on-surface-variant)",
            background: "var(--color-surface-container)",
            padding: "2px 8px",
            borderRadius: "10px",
          }}>
            {history.length}
          </span>
        </div>
        <button onClick={onClose} style={closeButtonStyle}>✕</button>
      </div>

      {/* Filters */}
      <div style={filtersStyle}>
        <button 
          onClick={() => setFilter("all")}
          style={{
            ...filterButtonStyle,
            ...(filter === "all" ? filterActiveStyle : {}),
          }}
        >
          Todas
        </button>
        <button 
          onClick={() => setFilter("completed")}
          style={{
            ...filterButtonStyle,
            ...(filter === "completed" ? filterActiveStyle : {}),
          }}
        >
          Completadas
        </button>
        <button 
          onClick={() => setFilter("failed")}
          style={{
            ...filterButtonStyle,
            ...(filter === "failed" ? filterActiveStyle : {}),
          }}
        >
          Fallidas
        </button>
      </div>

      {/* List */}
      <div style={listStyle}>
        {filteredHistory.length === 0 ? (
          <div style={emptyStyle}>
            <span style={{ fontSize: "32px", marginBottom: "8px" }}>🏃</span>
            <p>No hay ejecuciones registradas</p>
            <p style={{ fontSize: "12px", color: "var(--color-on-surface-variant)" }}>
              Las ejecuciones aparecerán aquí cuando ejecutes pruebas
            </p>
          </div>
        ) : (
          filteredHistory.map((entry) => (
            <div 
              key={entry.runId} 
              style={entryStyle}
              onClick={() => onViewRun?.(entry.runId)}
            >
              <div style={entryHeaderStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: getStatusColor(entry.status),
                  }} />
                  <span style={{ fontWeight: 500 }}>{entry.scenarioName || "Sin nombre"}</span>
                </div>
                <span style={{ 
                  fontSize: "11px", 
                  color: getStatusColor(entry.status),
                  fontWeight: 500,
                }}>
                  {getStatusText(entry.status)}
                </span>
              </div>
              <div style={entryMetaStyle}>
                <span>{formatDate(entry.startedAt)}</span>
                <span>•</span>
                <span>{entry.vus} VUs</span>
                <span>•</span>
                <span>{entry.duration}</span>
                <span>•</span>
                <span>{entry.iterations} iteraciones</span>
              </div>
              {entry.avgDuration !== undefined && (
                <div style={entryMetricsStyle}>
                  <span>Avg: {entry.avgDuration.toFixed(0)}ms</span>
                  {entry.errorRate !== undefined && entry.errorRate > 0 && (
                    <span style={{ color: "#ef4444" }}>
                      {(entry.errorRate * 100).toFixed(1)}% errores
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Styles
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "60px",
  right: "16px",
  width: "400px",
  maxHeight: "calc(100% - 80px)",
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "12px",
  display: "flex",
  flexDirection: "column",
  zIndex: 100,
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  fontFamily: "var(--font-sans)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px 8px",
  fontSize: "16px",
};

const filtersStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "12px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
};

const filterButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: "12px",
  background: "transparent",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "16px",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
};

const filterActiveStyle: React.CSSProperties = {
  background: "var(--color-primary)",
  borderColor: "var(--color-primary)",
  color: "white",
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "8px",
};

const emptyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "40px 20px",
  textAlign: "center",
  color: "var(--color-on-surface)",
};

const entryStyle: React.CSSProperties = {
  padding: "12px",
  background: "var(--color-surface-container)",
  borderRadius: "8px",
  marginBottom: "8px",
  cursor: "pointer",
  transition: "background 0.15s",
};

const entryHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "6px",
};

const entryMetaStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  fontSize: "11px",
  color: "var(--color-on-surface-variant)",
};

const entryMetricsStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  fontSize: "11px",
  color: "var(--color-on-surface-variant)",
  marginTop: "6px",
  paddingTop: "6px",
  borderTop: "1px solid var(--color-surface-container-high)",
};
