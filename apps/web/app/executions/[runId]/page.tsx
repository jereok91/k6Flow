"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { MainLayout } from "../../../lib/layout";

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

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch run details from orchestrator
        const runRes = await fetch(`/api/orchestrator/runs/${runId}`);
        if (!runRes.ok) {
          // Try local DB
          const localRes = await fetch(`/api/runs/${runId}`);
          if (localRes.ok) {
            const data = await localRes.json();
            setRun(data);
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
          });
        }

        // Fetch summary
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

  const formatDateTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("es-AR", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      finished: "#10b981",
      completed: "#10b981",
      failed: "#ef4444",
      aborted: "#6b7280",
      stopped: "#6b7280",
    };
    return colors[status] || "#6b7280";
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
        <div style={errorStyle}>
          {error || "Ejecución no encontrada"}
        </div>
        <button onClick={() => router.back()} style={backButtonStyle}>
          ← Volver
        </button>
      </div>
      </MainLayout>
    );
  }

  const elapsed = run.finishedAt && run.startedAt
    ? Math.floor((run.finishedAt - run.startedAt) / 1000)
    : 0;

  return (
    <MainLayout>
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <button onClick={() => router.back()} style={backButtonStyle}>
          ← Volver
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={titleStyle}>
            {run.scenarioName || run.id.slice(0, 12)}
          </h1>
          <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
            <span style={{
              color: getStatusColor(run.status),
              fontWeight: 600,
              textTransform: "uppercase",
              fontSize: 12,
            }}>
              {run.status}
            </span>
            {run.startedAt && (
              <span style={{ color: "var(--color-on-surface-variant)", fontSize: 12 }}>
                {formatDateTime(run.startedAt)}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={actionButtonStyle}>
            📊 Exportar
          </button>
          <button style={actionButtonStyle}>
            🔄 Re-ejecutar
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div style={overviewGridStyle}>
        <OverviewCard
          label="Duración Total"
          value={`${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, "0")}`}
        />
        <OverviewCard
          label="VUs Configurados"
          value={run.vus.toString()}
        />
        <OverviewCard
          label="Iteraciones"
          value={(summary?.totals.iterations || run.iterations || 0).toString()}
        />
        <OverviewCard
          label="Requests"
          value={(summary?.totals.requests || 0).toString()}
        />
      </div>

      {/* Summary Sections */}
      {summary && (
        <div style={sectionsGridStyle}>
          {/* Latency Section */}
          <div style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Latencia</h3>
            <div style={metricsGridStyle}>
              <MetricRow label="Promedio" value={formatDuration(summary.latency.avgMs)} />
              <MetricRow label="P90" value={formatDuration(summary.latency.p90Ms)} />
              <MetricRow label="P95" value={formatDuration(summary.latency.p95Ms)} />
              <MetricRow label="P99" value={formatDuration(summary.latency.p99Ms)} />
            </div>
          </div>

          {/* Errors Section */}
          <div style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Errores</h3>
            <div style={metricsGridStyle}>
              <MetricRow
                label="Errores HTTP"
                value={summary.totals.errors.toString()}
                highlight={summary.totals.errors > 0}
              />
              <MetricRow
                label="Checks Fallidos"
                value={summary.totals.failedChecks.toString()}
                highlight={summary.totals.failedChecks > 0}
              />
              <MetricRow
                label="Tasa de Error"
                value={summary.totals.requests > 0
                  ? `${((summary.totals.errors / summary.totals.requests) * 100).toFixed(2)}%`
                  : "0%"
                }
                highlight={summary.totals.errors > 0}
              />
            </div>
          </div>

          {/* Data Transfer Section */}
          <div style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Transferencia</h3>
            <div style={metricsGridStyle}>
              <MetricRow label="Recibido" value={formatBytes(summary.dataReceivedBytes)} />
              <MetricRow label="Enviado" value={formatBytes(summary.dataSentBytes)} />
            </div>
          </div>

          {/* Thresholds Section */}
          <div style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Thresholds</h3>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "16px",
              background: summary.thresholdsPassed
                ? "rgba(16, 185, 129, 0.1)"
                : summary.thresholdsPassed === false
                  ? "rgba(239, 68, 68, 0.1)"
                  : "var(--color-surface-container)",
              borderRadius: 8,
            }}>
              <span style={{ fontSize: 24 }}>
                {summary.thresholdsPassed ? "✅" : summary.thresholdsPassed === false ? "❌" : "➖"}
              </span>
              <span style={{
                fontWeight: 500,
                color: summary.thresholdsPassed
                  ? "#10b981"
                  : summary.thresholdsPassed === false
                    ? "#ef4444"
                    : "var(--color-on-surface-variant)",
              }}>
                {summary.thresholdsPassed
                  ? "Todos los thresholds pasaron"
                  : summary.thresholdsPassed === false
                    ? "Algunos thresholds fallaron"
                    : "Sin thresholds definidos"
                }
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
    </MainLayout>
  );
}

function OverviewCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: "var(--color-surface-container)",
      borderRadius: 8,
      padding: 16,
      textAlign: "center",
    }}>
      <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
        {value}
      </div>
    </div>
  );
}

function MetricRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
      <span style={{ color: "var(--color-on-surface-variant)", fontSize: 13 }}>{label}</span>
      <span style={{
        fontWeight: 500,
        fontFamily: "var(--font-mono)",
        color: highlight ? "#ef4444" : "var(--color-on-surface)",
      }}>
        {value}
      </span>
    </div>
  );
}

// Styles
const containerStyle: React.CSSProperties = {
  padding: 24,
  maxWidth: 1000,
  margin: "0 auto",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 24,
};

const backButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 500,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  margin: 0,
  color: "var(--color-on-surface)",
};

const actionButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  fontWeight: 500,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: 6,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  padding: 16,
  background: "rgba(239, 68, 68, 0.1)",
  color: "#ef4444",
  borderRadius: 8,
  marginBottom: 16,
};

const overviewGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 12,
  marginBottom: 24,
};

const sectionsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 16,
};

const sectionStyle: React.CSSProperties = {
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-surface-container)",
  borderRadius: 8,
  padding: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  margin: "0 0 12px 0",
  color: "var(--color-on-surface-variant)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const metricsGridStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};
