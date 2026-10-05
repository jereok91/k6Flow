"use client";

// Panel to display live K6 test execution with metrics and results.

import { useState, useEffect, useRef, useCallback } from "react";

interface RunMetrics {
  vus: number;
  iterations: number;
  requestRate: number;
  avgDuration: number;
  p95Duration: number;
  errorRate: number;
  dataReceived: number;
  dataSent: number;
}

interface RunExecutionPanelProps {
  runId: string;
  onClose: () => void;
  onComplete?: (result: RunResult) => void;
}

interface RunResult {
  runId: string;
  status: "completed" | "failed" | "stopped";
  duration: number;
  iterations: number;
  metrics: RunMetrics;
  errors: string[];
}

type RunStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export function RunExecutionPanel({ runId, onClose, onComplete }: RunExecutionPanelProps) {
  const [status, setStatus] = useState<RunStatus>("pending");
  const [metrics, setMetrics] = useState<RunMetrics>({
    vus: 0,
    iterations: 0,
    requestRate: 0,
    avgDuration: 0,
    p95Duration: 0,
    errorRate: 0,
    dataReceived: 0,
    dataSent: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number>(Date.now());

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Timer for elapsed time
  useEffect(() => {
    if (status !== "running" && status !== "pending") return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Poll run status
  useEffect(() => {
    let cancelled = false;
    
    const pollStatus = async () => {
      try {
        const res = await fetch(`/api/orchestrator/runs/${runId}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError("Run not found");
            setStatus("failed");
          }
          return;
        }
        
        const data = await res.json();
        if (cancelled) return;
        
        setStatus(data.status);
        
        if (data.metrics) {
          setMetrics(prev => ({
            ...prev,
            ...data.metrics,
          }));
        }
        
        if (data.status === "completed" || data.status === "failed" || data.status === "stopped") {
          onComplete?.({
            runId,
            status: data.status,
            duration: elapsed,
            iterations: metrics.iterations,
            metrics,
            errors: data.errors || [],
          });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch status");
        }
      }
    };

    // Initial fetch
    pollStatus();
    
    // Poll every 2 seconds while running
    const interval = setInterval(() => {
      if (status === "running" || status === "pending") {
        pollStatus();
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(async () => {
    try {
      await fetch(`/api/orchestrator/runs/${runId}/stop`, { method: "POST" });
      setStatus("stopped");
    } catch {
      setError("Failed to stop run");
    }
  }, [runId]);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const formatElapsed = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getStatusColor = (s: RunStatus) => {
    switch (s) {
      case "pending": return "#f59e0b";
      case "running": return "#10b981";
      case "completed": return "#10b981";
      case "failed": return "#ef4444";
      case "stopped": return "#6b7280";
      default: return "#6b7280";
    }
  };

  const getStatusText = (s: RunStatus) => {
    switch (s) {
      case "pending": return "Iniciando...";
      case "running": return "Ejecutando";
      case "completed": return "Completado";
      case "failed": return "Fallido";
      case "stopped": return "Detenido";
      default: return s;
    }
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {status === "running" && (
              <div style={pulseStyle} />
            )}
            <span style={{ 
              fontSize: "12px", 
              fontWeight: 600, 
              color: getStatusColor(status),
              textTransform: "uppercase",
            }}>
              {getStatusText(status)}
            </span>
          </div>
          <span style={{ fontSize: "12px", color: "var(--color-on-surface-variant)" }}>
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {(status === "running" || status === "pending") && (
            <button onClick={handleStop} style={stopButtonStyle}>
              Detener
            </button>
          )}
          <button onClick={onClose} style={closeButtonStyle}>
            ✕
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={errorStyle}>
          {error}
        </div>
      )}

      {/* Metrics Grid */}
      <div style={metricsGridStyle}>
        <MetricCard label="VUs Activos" value={metrics.vus.toString()} />
        <MetricCard label="Iteraciones" value={metrics.iterations.toString()} />
        <MetricCard label="Req/s" value={metrics.requestRate.toFixed(1)} />
        <MetricCard label="Avg Duration" value={formatDuration(metrics.avgDuration)} />
        <MetricCard label="P95 Duration" value={formatDuration(metrics.p95Duration)} />
        <MetricCard label="Error Rate" value={`${(metrics.errorRate * 100).toFixed(1)}%`} highlight={metrics.errorRate > 0.01} />
        <MetricCard label="Data Recibida" value={formatBytes(metrics.dataReceived)} />
        <MetricCard label="Data Enviada" value={formatBytes(metrics.dataSent)} />
      </div>

      {/* Logs */}
      <div style={logsContainerStyle}>
        <div style={logsTitleStyle}>Logs</div>
        <div style={logsStyle}>
          {logs.length === 0 ? (
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "12px" }}>
              Esperando logs...
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={logLineStyle}>{log}</div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Result summary for completed runs */}
      {(status === "completed" || status === "failed" || status === "stopped") && (
        <div style={resultSummaryStyle}>
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>
            Resumen de Ejecución
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "11px", color: "var(--color-on-surface-variant)" }}>Duración Total</div>
              <div style={{ fontSize: "16px", fontWeight: 600 }}>{formatElapsed(elapsed)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--color-on-surface-variant)" }}>Iteraciones</div>
              <div style={{ fontSize: "16px", fontWeight: 600 }}>{metrics.iterations}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--color-on-surface-variant)" }}>Requests/s Promedio</div>
              <div style={{ fontSize: "16px", fontWeight: 600 }}>{metrics.requestRate.toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Metric Card Component
function MetricCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      background: "var(--color-surface-container)",
      borderRadius: "8px",
      padding: "12px",
      textAlign: "center",
    }}>
      <div style={{ 
        fontSize: "11px", 
        color: "var(--color-on-surface-variant)",
        marginBottom: "4px",
      }}>
        {label}
      </div>
      <div style={{ 
        fontSize: "18px", 
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        color: highlight ? "#ef4444" : "var(--color-on-surface)",
      }}>
        {value}
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
  height: "50%",
  minHeight: "300px",
  maxHeight: "70%",
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
  padding: "12px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
  background: "var(--color-surface-container-low)",
};

const pulseStyle: React.CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background: "#10b981",
  animation: "pulse 1.5s ease-in-out infinite",
};

const stopButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: "12px",
  fontWeight: 500,
  background: "#ef4444",
  color: "white",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px 8px",
  fontSize: "16px",
};

const errorStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "rgba(239, 68, 68, 0.1)",
  color: "#ef4444",
  fontSize: "12px",
  borderBottom: "1px solid rgba(239, 68, 68, 0.3)",
};

const metricsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "12px",
  padding: "16px",
  borderBottom: "1px solid var(--color-surface-container)",
};

const logsContainerStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const logsTitleStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid var(--color-surface-container)",
};

const logsStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "12px 16px",
  fontFamily: "var(--font-mono)",
  fontSize: "11px",
  lineHeight: 1.6,
};

const logLineStyle: React.CSSProperties = {
  color: "var(--color-on-surface)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const resultSummaryStyle: React.CSSProperties = {
  padding: "16px",
  background: "var(--color-surface-container-low)",
  borderTop: "1px solid var(--color-surface-container)",
};
