"use client";

import { useState, useEffect, useRef, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { MainLayout } from "../../../lib/layout";
import { RpsChart, LatencyChart, Sparkline } from "../../../lib/editor/MetricsChart";

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

interface RunSummary {
  totals: {
    requests: number;
    errors: number;
    failedChecks: number;
    iterations: number;
  };
  latency: {
    avgMs: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  thresholdsPassed: boolean | null;
  dataReceivedBytes: number;
  dataSentBytes: number;
}

interface RunDetail {
  id: string;
  status: string;
  scenarioId?: string;
  scenarioName?: string;
  vus: number;
  durationMs: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  iterations?: number;
  avgDurationMs?: number;
  errorRate?: number;
}

type RunStatus = "queued" | "starting" | "running" | "stopping" | "finished" | "completed" | "failed" | "aborted" | "errored";

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Live execution state
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState<RunStatus>("queued");
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
  const [elapsed, setElapsed] = useState(0);
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

  const wsRef = useRef<WebSocket | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  // Fetch initial run data
  useEffect(() => {
    async function fetchData() {
      try {
        const runRes = await fetch(`/api/orchestrator/runs/${runId}`);
        if (!runRes.ok) {
          const localRes = await fetch(`/api/runs/${runId}`);
          if (localRes.ok) {
            const data = await localRes.json();
            setRun(data);
            setStatus(data.status as RunStatus);
            setIsLive(["queued", "starting", "running", "stopping"].includes(data.status));
          } else {
            throw new Error("Run not found");
          }
        } else {
          const data = await runRes.json();
          setRun({
            id: data.runId,
            status: data.status,
            vus: data.vus,
            durationMs: data.durationMs,
            createdAt: Date.now(),
            scenarioName: data.scenarioName,
          });
          setStatus(data.status as RunStatus);
          setIsLive(["queued", "starting", "running", "stopping"].includes(data.status));
        }

        const summaryRes = await fetch(`/api/orchestrator/runs/${runId}/summary`);
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          setSummary(summaryData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch run");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [runId]);

  // WebSocket for live metrics
  useEffect(() => {
    if (!isLive) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/orchestrator/ws/metrics/${runId}`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === "hello") {
          startTimeRef.current = Date.now();
        } else if (data.type === "tick") {
          const newMetrics: RunMetrics = {
            vus: data.currentVUs ?? data.vus ?? 0,
            iterations: data.iterations ?? 0,
            requestRate: data.requestsPerSecond ?? data.rps ?? 0,
            avgDuration: data.avgResponseTimeMs ?? data.avgDuration ?? 0,
            p95Duration: data.p95ResponseTimeMs ?? data.p95Duration ?? 0,
            errorRate: data.errorRate ?? 0,
            dataReceived: data.dataReceived ?? 0,
            dataSent: data.dataSent ?? 0,
          };
          setMetrics(newMetrics);
          setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
          
          setChartData(prev => ({
            time: [...prev.time, Date.now()].slice(-60),
            rps: [...prev.rps, newMetrics.requestRate].slice(-60),
            avgLatency: [...prev.avgLatency, newMetrics.avgDuration].slice(-60),
            p95Latency: [...prev.p95Latency, newMetrics.p95Duration].slice(-60),
            p99Latency: [...prev.p99Latency, newMetrics.p95Duration * 1.1].slice(-60),
            vus: [...prev.vus, newMetrics.vus].slice(-60),
            errorRate: [...prev.errorRate, newMetrics.errorRate].slice(-60),
          }));
        } else if (data.type === "state") {
          setStatus(data.status as RunStatus);
          if (!["queued", "starting", "running", "stopping"].includes(data.status)) {
            setIsLive(false);
          }
        } else if (data.type === "end") {
          setStatus((data.status || "finished") as RunStatus);
          setIsLive(false);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
    };

    ws.onerror = () => {
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [isLive, runId]);

  // Timer for elapsed time
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  const handleStop = useCallback(async () => {
    try {
      await fetch(`/api/orchestrator/runs/${runId}/stop`, { method: "POST" });
      setStatus("stopping");
    } catch {
      // Ignore
    }
  }, [runId]);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
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

  const getStatusColor = (s: string) => {
    const colors: Record<string, string> = {
      running: "#10b981",
      finished: "#10b981",
      completed: "#10b981",
      failed: "#ef4444",
      errored: "#ef4444",
      aborted: "#6b7280",
      stopped: "#6b7280",
      stopping: "#f59e0b",
      queued: "#6b7280",
      starting: "#3b82f6",
    };
    return colors[s] || "#6b7280";
  };

  if (loading) {
    return (
      <MainLayout>
        <div style={containerStyle}>
          <div style={{ padding: 48, textAlign: "center", color: "var(--color-on-surface-variant)" }}>
            Cargando...
          </div>
        </div>
      </MainLayout>
    );
  }

  if (error || !run) {
    return (
      <MainLayout>
        <div style={containerStyle}>
          <div style={errorBoxStyle}>
            {error || "Ejecución no encontrada"}
          </div>
          <button onClick={() => router.back()} style={backButtonStyle}>
            ← Volver
          </button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div style={containerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <button onClick={() => router.back()} style={backButtonStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
            Volver
          </button>
          <div style={{ flex: 1 }}>
            <h1 style={titleStyle}>
              {run.scenarioName || `Run ${runId.slice(0, 8)}`}
            </h1>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 4 }}>
              <span style={{
                color: getStatusColor(status),
                fontWeight: 600,
                textTransform: "uppercase",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}>
                {isLive && <span style={{ width: 8, height: 8, borderRadius: "50%", background: getStatusColor(status), animation: "pulse 1.5s infinite" }} />}
                {status}
              </span>
              {isLive && wsConnected && (
                <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
                  🔴 LIVE
                </span>
              )}
              <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>
                {formatElapsed(elapsed)}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {isLive && (
              <button onClick={handleStop} style={stopButtonStyle}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>stop</span>
                Detener
              </button>
            )}
          </div>
        </div>

        {/* Live KPIs */}
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
            label="Latencia Promedio" 
            value={`${Math.round(metrics.avgDuration)}ms`} 
            sparkData={chartData.avgLatency.slice(-30)}
            color="#f59e0b"
          />
          <KpiCard 
            label="Tasa de Error" 
            value={`${(metrics.errorRate * 100).toFixed(1)}%`} 
            sparkData={chartData.errorRate.slice(-30)}
            color={metrics.errorRate > 0.01 ? "#ef4444" : "#6b7280"}
            highlight={metrics.errorRate > 0.01}
          />
        </div>

        {/* Charts */}
        <div style={chartsGridStyle}>
          <div style={chartContainerStyle}>
            <h3 style={chartTitleStyle}>Requests/s</h3>
            <div style={{ height: 200 }}>
              <RpsChart 
                data={[
                  chartData.time.map((_, i) => i),
                  chartData.rps,
                ]}
                height={180}
              />
            </div>
          </div>
          <div style={chartContainerStyle}>
            <h3 style={chartTitleStyle}>Latencia (ms)</h3>
            <div style={{ height: 200 }}>
              <LatencyChart 
                data={[
                  chartData.time.map((_, i) => i),
                  chartData.avgLatency,
                  chartData.p95Latency,
                  chartData.p99Latency,
                ]}
                height={180}
              />
            </div>
          </div>
        </div>

        {/* Metrics Grid */}
        <div style={metricsGridStyle}>
          <MetricCard label="Iteraciones" value={metrics.iterations.toString()} />
          <MetricCard label="P95 Duration" value={`${Math.round(metrics.p95Duration)}ms`} />
          <MetricCard label="Data Recibida" value={formatBytes(metrics.dataReceived)} />
          <MetricCard label="Data Enviada" value={formatBytes(metrics.dataSent)} />
        </div>

        {/* Summary Section (for finished runs) */}
        {!isLive && summary && (
          <div style={summaryContainerStyle}>
            <h2 style={sectionTitleStyle}>Resumen de Ejecución</h2>
            <div style={summaryGridStyle}>
              <SummaryCard title="Latencia">
                <SummaryRow label="Promedio" value={formatDuration(summary.latency.avgMs)} />
                <SummaryRow label="P90" value={formatDuration(summary.latency.p90Ms)} />
                <SummaryRow label="P95" value={formatDuration(summary.latency.p95Ms)} />
                <SummaryRow label="P99" value={formatDuration(summary.latency.p99Ms)} />
              </SummaryCard>
              <SummaryCard title="Totales">
                <SummaryRow label="Requests" value={summary.totals.requests.toString()} />
                <SummaryRow label="Iteraciones" value={summary.totals.iterations.toString()} />
                <SummaryRow label="Errores" value={summary.totals.errors.toString()} highlight={summary.totals.errors > 0} />
                <SummaryRow label="Checks Fallidos" value={summary.totals.failedChecks.toString()} highlight={summary.totals.failedChecks > 0} />
              </SummaryCard>
              <SummaryCard title="Transferencia">
                <SummaryRow label="Recibido" value={formatBytes(summary.dataReceivedBytes)} />
                <SummaryRow label="Enviado" value={formatBytes(summary.dataSentBytes)} />
              </SummaryCard>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </MainLayout>
  );
}

// Components
function KpiCard({ label, value, sparkData, color, highlight }: { 
  label: string; 
  value: string; 
  sparkData: number[];
  color: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      ...kpiCardStyle,
      borderColor: highlight ? "#ef4444" : "var(--color-surface-container)",
    }}>
      <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: highlight ? "#ef4444" : "var(--color-on-surface)", fontFamily: "monospace" }}>
          {value}
        </span>
        <div style={{ width: 80, height: 32 }}>
          <Sparkline data={sparkData} color={color} />
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricCardStyle}>
      <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, fontFamily: "monospace", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={summaryCardStyle}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--color-on-surface)" }}>{title}</h3>
      {children}
    </div>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--color-surface-container)" }}>
      <span style={{ color: "var(--color-on-surface-variant)", fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 500, fontFamily: "monospace", color: highlight ? "#ef4444" : "var(--color-on-surface)" }}>{value}</span>
    </div>
  );
}

// Styles
const containerStyle: React.CSSProperties = {
  maxWidth: 1400,
  margin: "0 auto",
  padding: "24px 32px",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 24,
  paddingBottom: 16,
  borderBottom: "1px solid var(--color-surface-container)",
};

const backButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  background: "var(--color-surface-container)",
  border: "none",
  borderRadius: 8,
  color: "var(--color-on-surface)",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 600,
  margin: 0,
  color: "var(--color-on-surface)",
};

const stopButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 16px",
  background: "#ef4444",
  border: "none",
  borderRadius: 8,
  color: "white",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
};

const kpiGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 16,
  marginBottom: 24,
};

const kpiCardStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--color-surface-container)",
};

const chartsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 16,
  marginBottom: 24,
};

const chartContainerStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--color-surface-container)",
};

const chartTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 12,
  color: "var(--color-on-surface)",
};

const metricsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 16,
  marginBottom: 24,
};

const metricCardStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--color-surface-container)",
  textAlign: "center",
};

const summaryContainerStyle: React.CSSProperties = {
  marginTop: 32,
  paddingTop: 24,
  borderTop: "1px solid var(--color-surface-container)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 16,
  color: "var(--color-on-surface)",
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 16,
};

const summaryCardStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--color-surface-container)",
};

const errorBoxStyle: React.CSSProperties = {
  padding: 16,
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  borderRadius: 8,
  color: "#ef4444",
  marginBottom: 16,
};
