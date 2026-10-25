"use client";

// Panel to display live K6 test execution with metrics and results.

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { AsyncLifetime } from "./async-lifetime";
import { useRouter } from "next/navigation";
import { RpsChart, LatencyChart, Sparkline } from "./MetricsChart";
import { describeRunFailure } from "./run-failure";
import { normalizedRunStatus, runNotifications } from "./run-notifications";
import { appendFrameToChart, applyFrameToMetrics } from "./run-metrics";
import type { MetricsFrameInput } from "./run-metrics";
import { useToast } from "../notifications/ToastProvider";

// k6 exit code to human-readable error message (see run-failure.ts)
function formatRunFailure(input: { exitCode?: number | null; status?: string; vus?: number }): string {
  const { title, detail } = describeRunFailure(input);
  return `${title}\n${detail}`;
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
  /** Requested VU count, used to make failure messages more specific */
  vus?: number;
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

// Merge the orchestrator run summary (totals.iterations, latency.avgMs in ms,
// errors/requests as a 0-1 fraction) into the current metrics.
interface RunSummary {
  totals?: { iterations?: number; errors?: number; requests?: number };
  latency?: { avgMs?: number };
  dataReceivedBytes?: number;
  dataSentBytes?: number;
  errors?: string[];
}

function mergeSummaryMetrics(prev: RunMetrics, summary: RunSummary): RunMetrics {
  const errors = summary?.totals?.errors ?? 0;
  const requests = summary?.totals?.requests ?? 0;
  return {
    ...prev,
    iterations: summary?.totals?.iterations ?? prev.iterations,
    avgDuration: summary?.latency?.avgMs ?? prev.avgDuration,
    errorRate: errors > 0 && requests > 0 ? errors / requests : prev.errorRate,
    dataReceived: summary?.dataReceivedBytes ?? prev.dataReceived,
    dataSent: summary?.dataSentBytes ?? prev.dataSent,
  };
}

/**
 * Fetches a short-lived WS ticket for runId and returns the same-origin
 * socket URL, or null when no ticket could be obtained (caller polls).
 */
async function fetchRunWsUrl(runId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/orchestrator/ws-ticket?runId=${encodeURIComponent(runId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const ticket = (body as { ticket?: unknown } | null)?.ticket;
    if (typeof ticket !== "string" || ticket === "") return null;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}/api/ws/runs/${encodeURIComponent(runId)}?ticket=${encodeURIComponent(ticket)}`;
  } catch {
    return null;
  }
}

export function RunExecutionPanel({ runId, vus, onClose, onComplete }: RunExecutionPanelProps) {
  const router = useRouter();
  const notify = useToast();
  const callbacks = useRef({ onComplete, notify, vus });
  callbacks.current = { onComplete, notify, vus };
  const [stopPending, setStopPending] = useState(false);
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
  const stopLifetime = useRef(new AsyncLifetime());
  const stopInFlight = useRef(false);
  const stopRunId = useRef(runId);
  useLayoutEffect(() => {
    const session = stopLifetime.current;
    session.mount();
    stopRunId.current = runId;
    stopInFlight.current = false;
    setStopPending(false);
    setError(null);
    return () => session.unmount();
  }, [runId]);
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
  // k6 exit code from the WebSocket end message (the run GET has no exitCode)
  const exitCodeRef = useRef<number | null>(null);
  // Latest metrics, readable from long-lived effect/WebSocket/polling closures
  const metricsRef = useRef<RunMetrics>(metrics);
  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

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
    setStatus("pending");
    setLogs([]);
    setElapsed(0);
    setChartData({ time: [], rps: [], avgLatency: [], p95Latency: [], p99Latency: [], vus: [], errorRate: [] });
    const emptyMetrics = { vus: 0, iterations: 0, requestRate: 0, avgDuration: 0, p95Duration: 0, errorRate: 0, dataReceived: 0, dataSent: 0 };
    metricsRef.current = emptyMetrics;
    setMetrics(emptyMetrics);
    startTimeRef.current = Date.now();
    exitCodeRef.current = null;

    // Final metrics for onComplete: prefer the just-fetched summary, else latest state
    const finalMetrics = (summary?: RunSummary | null): RunMetrics =>
      summary ? mergeSummaryMetrics(metricsRef.current, summary) : metricsRef.current;

    // Fetch the run summary for final metrics (null on failure or after unmount)
    const fetchSummary = async (): Promise<RunSummary | null> => {
      if (cancelled) return null;
      try {
        const summaryRes = await fetch(`/api/orchestrator/runs/${runId}/summary`);
        if (!summaryRes.ok) return null;
        const fetched: RunSummary = await summaryRes.json();
        if (!cancelled) {
          setMetrics(prev => mergeSummaryMetrics(prev, fetched));
          // Show errors if any
          const summaryErrors = fetched.errors;
          if (summaryErrors && summaryErrors.length > 0) {
            setLogs(prev => [...prev, ...summaryErrors.map((e: string) => `[ERROR] ${e}`)]);
          }
        }
        return fetched;
      } catch {
        // Ignore summary fetch errors; fall back to latest metrics
        return null;
      }
    };

    // Fire onComplete exactly once per run, with summary-backed metrics
    let completionStarted = false;
    const completeRun = async (finalStatus: RunResult["status"], errors: string[]) => {
      if (completionStarted) return;
      completionStarted = true;
      const summary = await fetchSummary();
      if (cancelled) return;
      const completed = finalMetrics(summary);
      callbacks.current.onComplete?.({
        runId,
        status: finalStatus,
        duration: Math.floor((Date.now() - startTimeRef.current) / 1000),
        iterations: completed.iterations,
        metrics: completed,
        errors,
      });
    };
    
    const observeStatus = (value: unknown, errors: string[] = []) => {
      if (cancelled) return;
      const normalized = normalizedRunStatus(value);
      if (!normalized) return;
      // Never regress a terminal observation due to a delayed GET or WS frame.
      if (completionStarted) return;
      setStatus(normalized);
      const event = runNotifications.observe(runId, value);
      if (event) callbacks.current.notify({
        key: `run:${runId}:${event}`, type: event === "failed" ? "error" : event === "completed" ? "success" : "info",
        message: event === "running" ? "Ejecución iniciada" : event === "completed" ? "Ejecución completada" : event === "failed" ? "Ejecución fallida" : "Ejecución detenida",
      });
      if (normalized === "failed") setError(formatRunFailure({ exitCode: exitCodeRef.current, status: normalized, vus: callbacks.current.vus }));
      if (normalized !== "pending" && normalized !== "running") {
        setStopPending(false);
        void completeRun(normalized, errors);
      }
    };

    // One funnel for every frame source: the WS `tick`/`metrics` messages and
    // the polling fallback (REST snapshot) share the pure mapping, so the two
    // paths cannot diverge. `seq` identifies the window, so a snapshot the WS
    // already delivered (or the same snapshot on a later poll tick) is not
    // appended twice to the chart.
    let lastFrameSeq: number | null = null;
    const applyFrame = (frame: MetricsFrameInput) => {
      if (cancelled) return;
      const seq = typeof frame.seq === "number" ? frame.seq : null;
      if (seq !== null && seq === lastFrameSeq) return;
      lastFrameSeq = seq;
      setMetrics(prev => applyFrameToMetrics(prev, frame));
      setChartData(prev => appendFrameToChart(prev, frame));
    };

    // Fetch final status (for completion and errors)
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/orchestrator/runs/${runId}`);
        if (!res.ok) {
          if (res.status === 404 && !cancelled) setError("Ejecución no encontrada");
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
    
    // Connect WebSocket for live metrics: always same-origin through the
    // /api/ws proxy, authenticated by a fresh short-lived ticket (the service
    // token never reaches the browser). No ticket → status polling fallback.
    const connectWs = async () => {
      const wsUrl = await fetchRunWsUrl(runId);
      if (cancelled) return;
      if (!wsUrl) {
        setLogs(prev => [...prev, "[WS] Ticket unavailable - falling back to polling"]);
        startPolling();
        return;
      }

      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        if (cancelled) return;
        setWsConnected(true);
        setLogs(prev => [...prev, "[WS] Connected to metrics stream"]);
      };
      
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data);
          
          // Handle hello message (sent on connection)
          if (msg.type === "hello") {
            observeStatus(msg.status);
            setLogs(prev => [...prev, `[WS] Hello received - status: ${msg.status}, lastSeq: ${msg.lastSeq}`]);
            return;
          }

          // Handle state change messages
          if (msg.type === "state") {
            observeStatus(msg.toState);
            setLogs(prev => [...prev, `[STATE] ${msg.fromState} -> ${msg.toState}`]);
            return;
          }

          // Handle end message
          if (msg.type === "end") {
            if (typeof msg.exitCode === "number") {
              exitCodeRef.current = msg.exitCode;
            }
            observeStatus(msg.status);
            setLogs(prev => [...prev, `[END] Run ${msg.status} - exit code: ${msg.exitCode}`]);
            if (msg.status === "failed" || msg.status === "errored") {
              setError(formatRunFailure({ exitCode: exitCodeRef.current, status: msg.status, vus }));
            }
            return;
          }
          
          // Handle tick message (wraps metrics frame)
          if (msg.type === "tick" && msg.version === 1) {
            applyFrame(msg.frame);
            return;
          }

          // Legacy: handle direct metrics frame (backward compat)
          if (msg.type === "metrics" && msg.version === 1) {
            applyFrame(msg);
          }
        } catch {
          // Ignore malformed frames
        }
      };
      
      ws.onclose = async () => {
        if (cancelled) return;
        setWsConnected(false);
        const data = await fetchStatus();
        if (data && !cancelled) observeStatus(data.status, data.errors || []);
        if (!cancelled && !completionStarted) startPolling();
      };
      
      ws.onerror = () => {
        if (cancelled) return;
        setLogs(prev => [...prev, "[WS] Connection error - falling back to polling"]);
        // Fall back to polling on WS error
        startPolling();
      };
    };
    
    // Polling fallback. Each tick also fetches the latest window frame over
    // REST: with the WebSocket unavailable the cards and the chart must keep
    // moving. A missing snapshot (404) is silent and never touches status or
    // completion handling.
    let pollInterval: NodeJS.Timeout | null = null;
    const fetchMetricsSnapshot = async () => {
      try {
        const res = await fetch(`/api/orchestrator/runs/${runId}/metrics`, { cache: "no-store" });
        if (res.status !== 200) return;
        const frame: MetricsFrameInput = await res.json();
        applyFrame(frame);
      } catch {
        // No snapshot available: polling stays status-only for this tick.
      }
    };
    const startPolling = () => {
      if (pollInterval || cancelled || completionStarted) return;
      pollInterval = setInterval(async () => {
        if (!cancelled && !completionStarted) await fetchMetricsSnapshot();
        const data = await fetchStatus();
        if (data && !cancelled) {
          observeStatus(data.status, data.errors || []);
          if (completionStarted && pollInterval) clearInterval(pollInterval);
        }
      }, 2000);
    };
    
    // Start with initial status check, then connect WS
    fetchStatus().then(data => {
      if (data && !cancelled) {
        observeStatus(data.status, data.errors || []);
      }
      if (!cancelled && !completionStarted) {
        startPolling();
        void connectWs();
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
    const session = stopLifetime.current;
    const ticket = session.capture();
    const isCurrent = () => session.isCurrent(ticket) && stopRunId.current === runId;
    if (!isCurrent() || stopPending || stopInFlight.current) return;
    stopInFlight.current = true;
    setStopPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/orchestrator/runs/${runId}/stop`, { method: "POST" });
      if (!isCurrent()) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (!isCurrent()) return;
        throw new Error(data.error ?? `No se pudo detener la ejecución: ${res.status}`);
      }
      // Acknowledgement is not terminal: continue observing WS/GET status.
    } catch (err) {
      if (!isCurrent()) return;
      setStopPending(false);
      setError(err instanceof Error ? err.message : "No se pudo detener la ejecución");
    } finally {
      if (isCurrent()) stopInFlight.current = false;
    }
  }, [runId, stopPending]);

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
      case "pending": return "var(--color-warning)";
      case "running": return "var(--color-success)";
      case "finished":
      case "completed": return "var(--color-success)";
      case "failed": return "var(--color-danger)";
      case "stopped": return "var(--color-inactive)";
      default: return "var(--color-inactive)";
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
              color: "var(--color-success)",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)" }} />
              LIVE
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {(status === "running" || status === "pending") && (
            <button onClick={handleStop} disabled={stopPending} style={stopButtonStyle}>
              {stopPending ? "Deteniendo…" : "Detener"}
            </button>
          )}
          <button 
            onClick={() => router.push(`/executions/${runId}`)}
            style={fullPageButtonStyle}
            title="Abrir en página completa"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true" >open_in_full</span>
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
          color="var(--color-success)"
        />
        <KpiCard 
          label="Req/s" 
          value={metrics.requestRate.toFixed(1)} 
          sparkData={chartData.rps.slice(-30)}
          color="var(--color-primary)"
        />
        <KpiCard 
          label="Avg Latency" 
          value={formatDuration(metrics.avgDuration)} 
          sparkData={chartData.avgLatency.slice(-30)}
          color="var(--color-secondary)"
        />
        <KpiCard 
          label="Error Rate" 
          value={`${(metrics.errorRate * 100).toFixed(1)}%`} 
          sparkData={chartData.errorRate.slice(-30)}
          color="var(--color-danger)"
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
            color: highlight ? "var(--color-danger)" : "var(--color-on-surface)",
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
        color: highlight ? "var(--color-danger)" : "var(--color-on-surface)",
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
  background: "var(--color-success)",
  animation: "pulse 1.5s ease-in-out infinite",
};

const stopButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: "12px",
  fontWeight: 500,
  background: "var(--color-error-container)",
  color: "var(--color-on-error-container)",
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
  background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
  color: "var(--color-danger)",
  fontSize: "12px",
  whiteSpace: "pre-line",
  borderBottom: "1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)",
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
