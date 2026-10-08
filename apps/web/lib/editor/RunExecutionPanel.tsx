"use client";

// Panel to display live K6 test execution with metrics and results.

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { RpsChart, LatencyChart, Sparkline } from "./MetricsChart";

// K6 exit code to human-readable error message
function getK6ErrorMessage(status: string): string {
  // When status is "failed", k6 exited with a non-zero code
  // Common causes:
  // - Exit 107: Script initialization error (syntax error, missing import)
  // - Exit 99: Script error at init
  // - Exit 1: Threshold breach
  return "El script de k6 falló. Posibles causas:\n" +
    "• Error de sintaxis en el script generado\n" +
    "• Nodos sin configurar (URL vacía, etc.)\n" +
    "• Endpoint no accesible desde el contenedor\n" +
    "Revisa que todos los nodos tengan URLs válidas y accesibles.";
}

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
  status: "finished" | "completed" | "failed" | "stopped";
  duration: number;
  iterations: number;
  metrics: RunMetrics;
  errors: string[];
}

type RunStatus = "pending" | "running" | "finished" | "completed" | "failed" | "stopped";

export function RunExecutionPanel({ runId, onClose, onComplete }: RunExecutionPanelProps) {
  const router = useRouter();
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
  const [wsConnected, setWsConnected] = useState(false);
  const [chartData, setChartData] = useState<{
    time: number[];
    rps: number[];
    avgLatency: number[];
    p95Latency: number[];
    p99Latency: number[];
    vus: number[];
    errorRate: number[];
  }>({
    time: [],
    rps: [],
    avgLatency: [],
    p95Latency: [],
    p99Latency: [],
    vus: [],
    errorRate: [],
  });
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

  // WebSocket for live metrics + polling for status
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    
    // Fetch final status (for completion and errors)
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/orchestrator/runs/${runId}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError("Run not found");
            setStatus("failed");
          }
          return null;
        }
        return await res.json();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch status");
        }
        return null;
      }
    };
    
    // Connect WebSocket for live metrics
    const connectWs = () => {
      // In development, connect directly to orchestrator (exposed on :8080)
      // In production, use the proxy path through Caddy
      const isDev = window.location.port === "3000";
      const token = "k6flow-internal-token"; // Dev token
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = isDev 
        ? `ws://127.0.0.1:8080/ws/runs/${runId}?token=${token}`
        : `${protocol}//${window.location.host}/api/ws/runs/${runId}`;
      
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        setWsConnected(true);
        setLogs(prev => [...prev, "[WS] Connected to metrics stream"]);
      };
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          // Handle hello message (sent on connection)
          if (msg.type === "hello") {
            setStatus(msg.status as RunStatus || "running");
            setLogs(prev => [...prev, `[WS] Hello received - status: ${msg.status}, lastSeq: ${msg.lastSeq}`]);
            return;
          }

          // Handle state change messages
          if (msg.type === "state") {
            setStatus(msg.toState as RunStatus);
            setLogs(prev => [...prev, `[STATE] ${msg.fromState} -> ${msg.toState}`]);
            return;
          }

          // Handle end message
          if (msg.type === "end") {
            setStatus(msg.status as RunStatus);
            setLogs(prev => [...prev, `[END] Run ${msg.status} - exit code: ${msg.exitCode}`]);
            return;
          }
          
          // Handle tick message (wraps metrics frame)
          if (msg.type === "tick" && msg.version === 1) {
            const frame = msg.frame;
            const windowStartSec = (frame.window?.startMs ?? 0) / 1000;
            
            setMetrics(prev => ({
              ...prev,
              vus: frame.activeVUs ?? prev.vus,
              requestRate: frame.reqPerSec ?? prev.requestRate,
              avgDuration: frame.latencyMs?.avg ?? prev.avgDuration,
              p95Duration: frame.latencyMs?.p95 ?? prev.p95Duration,
              errorRate: frame.httpFailureFraction ?? prev.errorRate,
            }));

            // Update chart data
            setChartData(prev => ({
              time: [...prev.time, windowStartSec],
              rps: [...prev.rps, frame.reqPerSec ?? 0],
              avgLatency: [...prev.avgLatency, frame.latencyMs?.avg ?? 0],
              p95Latency: [...prev.p95Latency, frame.latencyMs?.p95 ?? 0],
              p99Latency: [...prev.p99Latency, frame.latencyMs?.p99 ?? 0],
              vus: [...prev.vus, frame.activeVUs ?? 0],
              errorRate: [...prev.errorRate, frame.httpFailureFraction ?? 0],
            }));
            return;
          }

          // Legacy: handle direct metrics frame (backward compat)
          if (msg.type === "metrics" && msg.version === 1) {
            const windowStartSec = (msg.window?.startMs ?? 0) / 1000;
            
            setMetrics(prev => ({
              ...prev,
              vus: msg.activeVUs ?? prev.vus,
              requestRate: msg.reqPerSec ?? prev.requestRate,
              avgDuration: msg.latencyMs?.avg ?? prev.avgDuration,
              p95Duration: msg.latencyMs?.p95 ?? prev.p95Duration,
              errorRate: msg.httpFailureFraction ?? prev.errorRate,
            }));

            setChartData(prev => ({
              time: [...prev.time, windowStartSec],
              rps: [...prev.rps, msg.reqPerSec ?? 0],
              avgLatency: [...prev.avgLatency, msg.latencyMs?.avg ?? 0],
              p95Latency: [...prev.p95Latency, msg.latencyMs?.p95 ?? 0],
              p99Latency: [...prev.p99Latency, msg.latencyMs?.p99 ?? 0],
              vus: [...prev.vus, msg.activeVUs ?? 0],
              errorRate: [...prev.errorRate, msg.httpFailureFraction ?? 0],
            }));
          }
        } catch {
          // Ignore malformed frames
        }
      };
      
      ws.onclose = async (event) => {
        setWsConnected(false);
        // Close code 1000 = normal completion
        if (event.code === 1000 || event.code === 1001) {
          // Fetch final status to get completion details
          const data = await fetchStatus();
          if (data && !cancelled) {
            const finalStatus = data.status as RunStatus;
            setStatus(finalStatus);
            if (finalStatus === "failed") {
              setError(getK6ErrorMessage(finalStatus));
              setLogs(prev => [...prev, "[ERROR] La ejecucion de k6 fallo"]);
            }
            if (finalStatus === "finished" || finalStatus === "completed" || finalStatus === "failed" || finalStatus === "stopped") {
              // Fetch summary for final metrics
              try {
                const summaryRes = await fetch(`/api/orchestrator/runs/${runId}/summary`);
                if (summaryRes.ok) {
                  const summary = await summaryRes.json();
                  setMetrics(prev => ({
                    ...prev,
                    iterations: summary.totals?.iterations ?? prev.iterations,
                    avgDuration: summary.latency?.avgMs ?? prev.avgDuration,
                    errorRate: summary.totals?.errors > 0 && summary.totals?.requests > 0
                      ? summary.totals.errors / summary.totals.requests
                      : prev.errorRate,
                    dataReceived: summary.dataReceivedBytes ?? prev.dataReceived,
                    dataSent: summary.dataSentBytes ?? prev.dataSent,
                  }));
                  // Show errors if any
                  if (summary.errors && summary.errors.length > 0) {
                    setLogs(prev => [...prev, ...summary.errors.map((e: string) => `[ERROR] ${e}`)]);
                  }
                }
              } catch {
                // Ignore summary fetch errors
              }
              onComplete?.({
                runId,
                status: finalStatus,
                duration: elapsed,
                iterations: metrics.iterations,
                metrics,
                errors: [],
              });
            }
          }
        } else {
          // Unexpected close - fetch status to check what happened
          const data = await fetchStatus();
          if (data && !cancelled) {
            setStatus(data.status as RunStatus);
            if (data.error) {
              setError(data.error);
              setLogs(prev => [...prev, `[ERROR] ${data.error}`]);
            }
          }
        }
      };
      
      ws.onerror = () => {
        setLogs(prev => [...prev, "[WS] Connection error - falling back to polling"]);
        // Fall back to polling on WS error
        startPolling();
      };
    };
    
    // Polling fallback
    let pollInterval: NodeJS.Timeout | null = null;
    const startPolling = () => {
      if (pollInterval) return;
      pollInterval = setInterval(async () => {
        const data = await fetchStatus();
        if (data && !cancelled) {
          setStatus(data.status);
          if (data.status === "failed") {
            setError(getK6ErrorMessage(data.status));
            setLogs(prev => [...prev, "[ERROR] La ejecucion de k6 fallo"]);
          }
          if (data.status === "finished" || data.status === "completed" || data.status === "failed" || data.status === "stopped") {
            if (pollInterval) clearInterval(pollInterval);
            onComplete?.({
              runId,
              status: data.status,
              duration: elapsed,
              iterations: metrics.iterations,
              metrics,
              errors: data.errors || [],
            });
          }
        }
      }, 2000);
    };
    
    // Start with initial status check, then connect WS
    fetchStatus().then(data => {
      if (data && !cancelled) {
        setStatus(data.status);
        if (data.status === "running" || data.status === "pending") {
          connectWs();
        } else {
          // Already finished
          onComplete?.({
            runId,
            status: data.status,
            duration: elapsed,
            iterations: metrics.iterations,
            metrics,
            errors: data.errors || [],
          });
        }
      }
    });

    return () => {
      cancelled = true;
      if (ws) {
        ws.close();
      }
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(async () => {
    try {
      const res = await fetch(`/api/orchestrator/runs/${runId}/stop`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Stop failed: ${res.status}`);
      }
      setStatus("stopped");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop run");
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
      case "finished":
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
      case "finished":
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
          {wsConnected && (
            <span style={{ 
              fontSize: "10px", 
              color: "#10b981",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }} />
              LIVE
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {(status === "running" || status === "pending") && (
            <button onClick={handleStop} style={stopButtonStyle}>
              Detener
            </button>
          )}
          <button 
            onClick={() => router.push(`/executions/${runId}`)}
            style={fullPageButtonStyle}
            title="Abrir en página completa"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>open_in_full</span>
          </button>
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

      {/* KPIs with Sparklines */}
      <div style={kpiGridStyle}>
        <KpiCard 
          label="VUs Activos" 
          value={metrics.vus.toString()} 
          sparkData={chartData.vus.slice(-30)}
          color="#10b981"
        />
        <KpiCard 
          label="Req/s" 
          value={metrics.requestRate.toFixed(1)} 
          sparkData={chartData.rps.slice(-30)}
          color="#8b5cf6"
        />
        <KpiCard 
          label="Avg Latency" 
          value={formatDuration(metrics.avgDuration)} 
          sparkData={chartData.avgLatency.slice(-30)}
          color="#06b6d4"
        />
        <KpiCard 
          label="Error Rate" 
          value={`${(metrics.errorRate * 100).toFixed(1)}%`} 
          sparkData={chartData.errorRate.slice(-30)}
          color="#ef4444"
          highlight={metrics.errorRate > 0.01}
        />
      </div>

      {/* Charts */}
      {chartData.time.length > 1 && (
        <div style={chartsContainerStyle}>
          <RpsChart 
            data={[chartData.time, chartData.rps]} 
            width={360}
            height={150}
          />
          <LatencyChart 
            data={[chartData.time, chartData.avgLatency, chartData.p95Latency, chartData.p99Latency]} 
            width={360}
            height={150}
          />
        </div>
      )}

      {/* Additional Metrics */}
      <div style={metricsGridStyle}>
        <MetricCard label="Iteraciones" value={metrics.iterations.toString()} />
        <MetricCard label="P95 Duration" value={formatDuration(metrics.p95Duration)} />
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
      {(status === "finished" || status === "completed" || status === "failed" || status === "stopped") && (
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

// KPI Card with Sparkline
function KpiCard({ label, value, sparkData, color, highlight }: { 
  label: string; 
  value: string; 
  sparkData: number[];
  color: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      background: "var(--color-surface-container)",
      borderRadius: "8px",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ 
            fontSize: "10px", 
            color: "var(--color-on-surface-variant)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}>
            {label}
          </div>
          <div style={{ 
            fontSize: "20px", 
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            color: highlight ? "#ef4444" : "var(--color-on-surface)",
          }}>
            {value}
          </div>
        </div>
        {sparkData.length > 2 && (
          <Sparkline data={sparkData} width={80} height={28} color={color} />
        )}
      </div>
    </div>
  );
}

// Metric Card Component (simplified)
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

const fullPageButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "4px",
  transition: "background 0.15s",
};

const errorStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "rgba(239, 68, 68, 0.1)",
  color: "#ef4444",
  fontSize: "12px",
  borderBottom: "1px solid rgba(239, 68, 68, 0.3)",
};

const kpiGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "12px",
  padding: "16px",
  borderBottom: "1px solid var(--color-surface-container)",
};

const chartsContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: "12px",
  padding: "12px 16px",
  borderBottom: "1px solid var(--color-surface-container)",
  overflow: "auto",
};

const metricsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "12px",
  padding: "12px 16px",
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
