"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MainLayout } from "../../lib/layout";
import { useActiveRuns } from "../../lib/orchestrator/use-active-runs";
import { historyRunRows, type ExecutionsRunRow } from "../../lib/editor/run-history-row";
import { runEditorHref } from "../../lib/editor/editor-route-params";

type Tab = "active" | "queued" | "history";

export default function ExecutionsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("active");
  // Active/queued come live from the global runs feed (no polling).
  const { active: activeRuns, queued: queuedRuns, loaded: liveLoaded, endSeq } = useActiveRuns();
  const [historyRuns, setHistoryRuns] = useState<ExecutionsRunRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loading = historyLoading || !liveLoaded;

  const fetchHistory = useCallback(async () => {
    try {
      // Fetch history from local DB
      const historyRes = await fetch("/api/runs");
      if (historyRes.ok) {
        const data = await historyRes.json();
        // History rows are keyed `runId`; the table navigates with `id`.
        setHistoryRuns(historyRunRows(data));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch runs");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // History is read on mount and refreshed whenever the feed reports a run end.
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory, endSeq]);

  const handleEmergencyStop = async () => {
    if (!confirm("¿Detener TODAS las ejecuciones activas?")) return;
    
    try {
      const res = await fetch("/api/orchestrator/runs/emergency-stop", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        alert(`Detenidas ${data.stoppedRuns} ejecuciones`);
        fetchHistory();
      }
    } catch (err) {
      alert("Error al detener ejecuciones");
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatTime = (timestamp: number | string) => {
    return new Date(timestamp).toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // History rows carry an ISO `startedAt`, feed rows epoch millis, and a row may
  // carry neither: render that as absent instead of "Invalid Date".
  const startedAtLabel = (run: ExecutionsRunRow) => {
    const startedAt = run.startedAt ?? run.createdAt;
    return startedAt === undefined ? "-" : formatTime(startedAt);
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      queued: "#f59e0b",
      pending: "#f59e0b",
      starting: "#f59e0b",
      running: "#10b981",
      stopping: "#6b7280",
      finished: "#10b981",
      failed: "#ef4444",
      aborted: "#6b7280",
      stopped: "#6b7280",
    };
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: `${colors[status] || "#6b7280"}20`,
        color: colors[status] || "#6b7280",
      }}>
        {status === "running" && (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: colors[status],
            animation: "pulse 1.5s infinite",
          }} />
        )}
        {status.toUpperCase()}
      </span>
    );
  };

  const currentRuns: ExecutionsRunRow[] = tab === "active" ? activeRuns : tab === "queued" ? queuedRuns : historyRuns;

  return (
    <MainLayout>
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Ejecuciones</h1>
          <p style={subtitleStyle}>
            {activeRuns.length} activas · {queuedRuns.length} en cola
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {activeRuns.length > 0 && (
            <button onClick={handleEmergencyStop} style={emergencyButtonStyle}>
              ⚠️ Detener Todo
            </button>
          )}
          <button onClick={() => router.push("/scenarios")} style={newButtonStyle}>
            + Nueva Prueba
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={tabsStyle}>
        <button
          onClick={() => setTab("active")}
          style={tab === "active" ? activeTabStyle : tabStyle}
        >
          En Curso ({activeRuns.length})
        </button>
        <button
          onClick={() => setTab("queued")}
          style={tab === "queued" ? activeTabStyle : tabStyle}
        >
          En Cola ({queuedRuns.length})
        </button>
        <button
          onClick={() => setTab("history")}
          style={tab === "history" ? activeTabStyle : tabStyle}
        >
          Historial
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div style={emptyStyle}>Cargando...</div>
      ) : error ? (
        <div style={errorStyle}>{error}</div>
      ) : currentRuns.length === 0 ? (
        <div style={emptyStyle}>
          {tab === "active" && "No hay ejecuciones activas"}
          {tab === "queued" && "No hay ejecuciones en cola"}
          {tab === "history" && "No hay historial de ejecuciones"}
        </div>
      ) : (
        <div style={tableContainerStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Estado</th>
                <th style={thStyle}>Escenario</th>
                <th style={thStyle}>VUs</th>
                <th style={thStyle}>Duración</th>
                <th style={thStyle}>Inicio</th>
                <th style={thStyle}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {currentRuns.map((run) => (
                <tr key={run.id} style={trStyle}>
                  <td style={tdStyle}>{getStatusBadge(run.status)}</td>
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 500 }}>
                      {run.scenarioName || run.id.slice(0, 12)}
                    </span>
                  </td>
                  <td style={tdStyle}>{run.vus}</td>
                  <td style={tdStyle}>{formatDuration(run.durationMs)}</td>
                  <td style={tdStyle}>{startedAtLabel(run)}</td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => {
                        if (run.status === "running" || run.status === "pending" || run.status === "queued") {
                          router.push(runEditorHref(run.id));
                        } else {
                          router.push(`/executions/${run.id}`);
                        }
                      }}
                      style={actionButtonStyle}
                    >
                      Ver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </MainLayout>
  );
}

// Styles
const containerStyle: React.CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: "24px",
};

const titleStyle: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: 600,
  margin: 0,
  color: "var(--color-on-surface)",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "var(--color-on-surface-variant)",
  margin: "4px 0 0 0",
};

const emergencyButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  background: "#ef4444",
  color: "white",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const newButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  background: "var(--color-primary)",
  color: "white",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const tabsStyle: React.CSSProperties = {
  display: "flex",
  gap: "4px",
  marginBottom: "16px",
  borderBottom: "1px solid var(--color-surface-container)",
  paddingBottom: "8px",
};

const tabStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "13px",
  fontWeight: 500,
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  border: "none",
  borderRadius: "6px 6px 0 0",
  cursor: "pointer",
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  background: "var(--color-surface-container)",
  color: "var(--color-primary)",
};

const emptyStyle: React.CSSProperties = {
  padding: "48px",
  textAlign: "center",
  color: "var(--color-on-surface-variant)",
};

const errorStyle: React.CSSProperties = {
  padding: "16px",
  background: "rgba(239, 68, 68, 0.1)",
  color: "#ef4444",
  borderRadius: "8px",
};

const tableContainerStyle: React.CSSProperties = {
  background: "var(--color-surface-container-lowest)",
  borderRadius: "8px",
  overflow: "hidden",
  border: "1px solid var(--color-surface-container)",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  fontSize: "11px",
  fontWeight: 600,
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
  fontSize: "13px",
  color: "var(--color-on-surface)",
};

const actionButtonStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "12px",
  fontWeight: 500,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "4px",
  cursor: "pointer",
};
