"use client";

import { useState, useEffect, useRef, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { MainLayout } from "../../../lib/layout";
import { RpsChart, LatencyChart, Sparkline } from "../../../lib/editor/MetricsChart";
import { describeRunFailure } from "../../../lib/editor/run-failure";

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

/** Flat row of GET /runs/{id}/endpoints (docs/api/runs.md). */
interface EndpointData {
  method: string;
  url: string;
  name?: string;
  requests: number;
  failures: number;
  /** failures / requests as a 0-1 fraction */
  errorRate?: number;
  avgDurationMs: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  p95DurationMs: number;
}

/** Flat row of GET /runs/{id}/failures (docs/api/runs.md). */
interface FailureData {
  method: string;
  url: string;
  /** 0 = network error (no HTTP response) */
  status: number;
  errorCode?: string;
  count: number;
  lastError?: string;
  lastSeenMs?: number;
}

const LIVE_STATUSES = ["queued", "starting", "running", "stopping", "pending"];
const TERMINAL_STATUSES = ["finished", "failed", "aborted", "errored", "stopped", "completed"];
const isTerminalStatus = (s: string) => TERMINAL_STATUSES.includes(s);
/** Live refresh period for the endpoints/failures tabs. */
const LIVE_REFRESH_MS = 5000;

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
  /** k6 exit code, when the backing API provides it */
  exitCode?: number | null;
}

type RunStatus = "queued" | "starting" | "running" | "stopping" | "finished" | "completed" | "failed" | "aborted" | "errored";
type TabType = "overview" | "endpoints" | "errors";

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  
  // Endpoints and failures data
  const [endpoints, setEndpoints] = useState<EndpointData[]>([]);
  const [failures, setFailures] = useState<FailureData[]>([]);
  
  // Live execution state
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState<RunStatus>("queued");
  // k6 exit code: from the run data when available, else from the WS end message
  const [exitCode, setExitCode] = useState<number | null>(null);
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
            if (typeof data.exitCode === "number") setExitCode(data.exitCode);
            setStatus(data.status as RunStatus);
            setIsLive(LIVE_STATUSES.includes(data.status));
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
          if (typeof data.exitCode === "number") setExitCode(data.exitCode);
          setStatus(data.status as RunStatus);
          setIsLive(LIVE_STATUSES.includes(data.status));
        }
        // Summary, endpoints and failures are loaded by the effects below:
        // periodically while live, once when terminal (summary only then; a
        // nonterminal summary answers 409).
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
          if (!LIVE_STATUSES.includes(data.status)) {
            setIsLive(false);
          }
        } else if (data.type === "end") {
          if (typeof data.exitCode === "number") setExitCode(data.exitCode);
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

  const fetchEndpointsAndFailures = useCallback(async () => {
    try {
      const [endpointsRes, failuresRes] = await Promise.all([
        fetch(`/api/orchestrator/runs/${runId}/endpoints`),
        fetch(`/api/orchestrator/runs/${runId}/failures`),
      ]);
      if (endpointsRes.ok) {
        const data = await endpointsRes.json();
        setEndpoints(data.endpoints || []);
      }
      if (failuresRes.ok) {
        const data = await failuresRes.json();
        setFailures(data.failures || []);
      }
    } catch {
      // Ignore errors; the next refresh retries
    }
  }, [runId]);

  // While live: refresh endpoints/failures every 5s, only while the tab is visible
  useEffect(() => {
    if (loading || !isLive) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") fetchEndpointsAndFailures();
    };
    refreshIfVisible();
    const interval = setInterval(refreshIfVisible, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [isLive, loading, fetchEndpointsAndFailures]);

  // Once terminal: final endpoints/failures refresh and the summary
  const terminal = isTerminalStatus(status);
  useEffect(() => {
    if (loading || isLive || !terminal) return;
    fetchEndpointsAndFailures();
    (async () => {
      try {
        const summaryRes = await fetch(`/api/orchestrator/runs/${runId}/summary`);
        if (summaryRes.ok) {
          setSummary(await summaryRes.json());
        }
      } catch {
        // Ignore errors
      }
    })();
  }, [isLive, terminal, loading, runId, fetchEndpointsAndFailures]);

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
  
  const getMethodColor = (method: string) => {
    const colors: Record<string, string> = {
      GET: "#10b981",
      POST: "#3b82f6",
      PUT: "#f59e0b",
      DELETE: "#ef4444",
      PATCH: "#8b5cf6",
    };
    return colors[method] || "#6b7280";
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
                <span style={{ fontSize: 11, color: "#ef4444", fontWeight: 600 }}>
                  ● LIVE
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

        {/* Failure explanation */}
        {(status === "failed" || status === "errored") && (() => {
          const failure = describeRunFailure({ exitCode, status, vus: run.vus });
          return (
            <div style={{ ...errorBoxStyle, whiteSpace: "pre-line" }}>
              <strong>{failure.title}</strong>
              {"\n"}
              {failure.detail}
            </div>
          );
        })()}

        {/* Tabs */}
        <div style={tabsContainerStyle}>
          <button
            onClick={() => setActiveTab("overview")}
            style={{
              ...tabStyle,
              ...(activeTab === "overview" ? activeTabStyle : {}),
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>monitoring</span>
            Overview
          </button>
          <button
            onClick={() => setActiveTab("endpoints")}
            style={{
              ...tabStyle,
              ...(activeTab === "endpoints" ? activeTabStyle : {}),
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>api</span>
            Endpoints
            {endpoints.length > 0 && (
              <span style={tabBadgeStyle}>{endpoints.length}</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("errors")}
            style={{
              ...tabStyle,
              ...(activeTab === "errors" ? activeTabStyle : {}),
              color: failures.length > 0 || metrics.errorRate > 0 ? "#ef4444" : undefined,
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
            Errores
            {(failures.length > 0 || metrics.errorRate > 0) && (
              <span style={{ ...tabBadgeStyle, background: "#ef4444" }}>
                {failures.length || Math.round(metrics.errorRate * metrics.iterations)}
              </span>
            )}
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === "overview" && (
          <>
            {/* KPIs - use summary data when run is finished, live data when running */}
            {(() => {
              const showSummary = !isLive && summary;
              const displayVus = showSummary ? (run?.vus || 0) : metrics.vus;
              const displayIterations = showSummary ? summary.totals.iterations : metrics.iterations;
              const displayLatency = showSummary ? summary.latency.avgMs : metrics.avgDuration;
              const displayErrorRate = showSummary && summary.totals.requests > 0
                ? summary.totals.errors / summary.totals.requests
                : metrics.errorRate;
              
              return (
                <div style={kpiGridStyle}>
                  <KpiCard 
                    label={isLive ? "VUs Activos" : "VUs Configurados"}
                    value={displayVus.toString()} 
                    sparkData={chartData.vus.slice(-30)}
                    color="#10b981"
                  />
                  <KpiCard 
                    label={isLive ? "Req/s" : "Iteraciones"}
                    value={isLive ? metrics.requestRate.toFixed(1) : displayIterations.toLocaleString()} 
                    sparkData={chartData.rps.slice(-30)}
                    color="#8b5cf6"
                  />
                  <KpiCard 
                    label="Latencia Promedio" 
                    value={`${Math.round(displayLatency)}ms`} 
                    sparkData={chartData.avgLatency.slice(-30)}
                    color="#f59e0b"
                  />
                  <KpiCard 
                    label="Tasa de Error" 
                    value={`${(displayErrorRate * 100).toFixed(1)}%`} 
                    sparkData={chartData.errorRate.slice(-30)}
                    color={displayErrorRate > 0.01 ? "#ef4444" : "#6b7280"}
                    highlight={displayErrorRate > 0.01}
                  />
                </div>
              );
            })()}

            {/* Charts */}
            <div style={chartsGridStyle}>
              <div style={chartContainerStyle}>
                <h3 style={chartTitleStyle}>Requests/s</h3>
                <div style={{ height: 220 }}>
                  <RpsChart 
                    data={[
                      chartData.time.map((_, i) => i),
                      chartData.rps,
                    ]}
                    height={200}
                  />
                </div>
              </div>
              <div style={chartContainerStyle}>
                <h3 style={chartTitleStyle}>Latencia (ms)</h3>
                <div style={{ height: 220 }}>
                  <LatencyChart 
                    data={[
                      chartData.time.map((_, i) => i),
                      chartData.avgLatency,
                      chartData.p95Latency,
                      chartData.p99Latency,
                    ]}
                    height={200}
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
                <h2 style={sectionTitleStyle}>Resumen Final</h2>
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
          </>
        )}

        {activeTab === "endpoints" && (
          <div style={tabContentStyle}>
            <h2 style={sectionTitleStyle}>Endpoints ({endpoints.length})</h2>
            {endpoints.length === 0 ? (
              <div style={emptyStateStyle}>
                <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3 }}>api</span>
                <p>No hay datos de endpoints disponibles</p>
                <p style={{ fontSize: 12, opacity: 0.7 }}>
                  {isLive ? "Los datos se actualizan cada 5 segundos durante la ejecución" : "No se registraron requests HTTP"}
                </p>
              </div>
            ) : (
              <div style={tableContainerStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Método</th>
                      <th style={{ ...thStyle, textAlign: "left" }}>URL</th>
                      <th style={thStyle}>Requests</th>
                      <th style={thStyle}>Errores</th>
                      <th style={thStyle}>Error %</th>
                      <th style={thStyle}>Avg (ms)</th>
                      <th style={thStyle}>P95 (ms)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map((ep, i) => {
                      const rate = typeof ep.errorRate === "number"
                        ? ep.errorRate
                        : ep.requests > 0 ? ep.failures / ep.requests : 0;
                      const errorPct = rate * 100;
                      const showName = !!ep.name && ep.name !== ep.url;
                      return (
                        <tr key={i} style={trStyle}>
                          <td style={tdStyle}>
                            <span style={{ 
                              ...methodBadgeStyle, 
                              background: getMethodColor(ep.method) 
                            }}>
                              {ep.method}
                            </span>
                          </td>
                          <td
                            style={{ ...tdStyle, textAlign: "left", fontFamily: "monospace", fontSize: 12 }}
                            title={showName ? `name: ${ep.name}` : undefined}
                          >
                            <div style={truncateStyle} title={ep.url}>{ep.url}</div>
                            {showName && (
                              <div style={{ ...truncateStyle, fontSize: 11, color: "var(--color-on-surface-variant)" }}>
                                {ep.name}
                              </div>
                            )}
                          </td>
                          <td style={tdStyle}>{ep.requests.toLocaleString()}</td>
                          <td style={{ ...tdStyle, color: ep.failures > 0 ? "#ef4444" : undefined }}>
                            {ep.failures.toLocaleString()}
                          </td>
                          <td style={{ ...tdStyle, color: errorPct > 1 ? "#ef4444" : undefined }}>
                            {errorPct.toFixed(1)}%
                          </td>
                          <td style={tdStyle}>{ep.avgDurationMs.toFixed(0)}</td>
                          <td style={tdStyle}>{ep.p95DurationMs.toFixed(0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "errors" && (
          <div style={tabContentStyle}>
            <h2 style={sectionTitleStyle}>
              Errores 
              {(failures.length > 0 || metrics.errorRate > 0) && (
                <span style={{ color: "#ef4444", marginLeft: 8 }}>
                  ({failures.length || Math.round(metrics.errorRate * metrics.iterations)})
                </span>
              )}
            </h2>
            {failures.length === 0 && metrics.errorRate === 0 ? (
              <div style={emptyStateStyle}>
                <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#10b981" }}>check_circle</span>
                <p style={{ color: "#10b981" }}>Sin errores</p>
                <p style={{ fontSize: 12, opacity: 0.7 }}>Todos los requests fueron exitosos</p>
              </div>
            ) : failures.length === 0 ? (
              <div style={emptyStateStyle}>
                <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3 }}>error</span>
                <p>Tasa de error: {(metrics.errorRate * 100).toFixed(2)}%</p>
                <p style={{ fontSize: 12, opacity: 0.7 }}>
                  {isLive ? "Los detalles de errores se actualizan cada 5 segundos" : "No hay detalles de errores disponibles"}
                </p>
              </div>
            ) : (
              <div style={tableContainerStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Método</th>
                      <th style={{ ...thStyle, textAlign: "left" }}>URL</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Código</th>
                      <th style={{ ...thStyle, textAlign: "left" }}>Mensaje</th>
                      <th style={thStyle}>Cantidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map((f, i) => (
                      <tr key={i} style={trStyle}>
                        <td style={tdStyle}>
                          <span style={{ 
                            ...methodBadgeStyle, 
                            background: getMethodColor(f.method) 
                          }}>
                            {f.method}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "left", fontFamily: "monospace", fontSize: 12 }}>
                          <div style={truncateStyle} title={f.url}>{f.url}</div>
                        </td>
                        <td style={{ ...tdStyle, color: "#ef4444", fontWeight: 600 }}>
                          {f.status === 0 ? "network" : f.status}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>
                          {f.errorCode || "-"}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "left", fontSize: 12 }}>
                          <div style={{ ...truncateStyle, maxWidth: 360 }} title={f.lastError || undefined}>
                            {f.lastError || "-"}
                          </div>
                        </td>
                        <td style={tdStyle}>{f.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            
            {/* Error Rate Over Time Chart */}
            {chartData.errorRate.some(r => r > 0) && (
              <div style={{ marginTop: 24 }}>
                <h3 style={chartTitleStyle}>Tasa de Error en el Tiempo</h3>
                <div style={{ ...chartContainerStyle, height: 200 }}>
                  <RpsChart 
                    data={[
                      chartData.time.map((_, i) => i),
                      chartData.errorRate.map(r => r * 100),
                    ]}
                    height={180}
                  />
                </div>
              </div>
            )}
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
  marginBottom: 16,
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

const tabsContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 24,
  borderBottom: "1px solid var(--color-surface-container)",
  paddingBottom: 0,
};

const tabStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "12px 16px",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 500,
  marginBottom: -1,
};

const activeTabStyle: React.CSSProperties = {
  color: "var(--color-primary)",
  borderBottomColor: "var(--color-primary)",
};

const tabBadgeStyle: React.CSSProperties = {
  background: "var(--color-primary)",
  color: "white",
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 6px",
  borderRadius: 10,
  minWidth: 18,
  textAlign: "center",
};

const tabContentStyle: React.CSSProperties = {
  minHeight: 400,
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

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 48,
  color: "var(--color-on-surface-variant)",
  textAlign: "center",
  gap: 8,
};

const tableContainerStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  borderRadius: 12,
  border: "1px solid var(--color-surface-container)",
  overflow: "hidden",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  padding: "12px 16px",
  textAlign: "center",
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderBottom: "1px solid var(--color-surface-container-high)",
};

const trStyle: React.CSSProperties = {
  borderBottom: "1px solid var(--color-surface-container)",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 16px",
  textAlign: "center",
  color: "var(--color-on-surface)",
};

const truncateStyle: React.CSSProperties = {
  maxWidth: 480,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const methodBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  color: "white",
};
