"use client";

// K6F4-05b/c/06 + K6F5-03: Visual scenario editor page with save/load/run functionality.
// Authenticated users only.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  FlowEditor,
  HttpRequestConfigPanel,
  AuthenticationConfigPanel,
  ResponseValidationConfigPanel,
  UserPoolConfigPanel,
  type K6NodeType,
  type K6Edge,
  type K6NodeData,
} from "../../lib/editor";
import { useScenario } from "../../lib/editor/use-scenario";
import { useRun } from "../../lib/editor/use-run";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  error?: string;
}

interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export default function EditorPage() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [nodes, setNodes] = useState<K6NodeType[]>([]);
  const [edges, setEdges] = useState<K6Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<K6NodeType | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [scenarioNameInput, setScenarioNameInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);

  const scenario = useScenario();
  const run = useRun();
  const router = useRouter();

  // Check orchestrator on mount
  useEffect(() => {
    run.checkOrchestrator();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Check authentication on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => {
        if (res.ok) {
          setAuth({ loading: false, authenticated: true });
        } else if (res.status === 401) {
          setAuth({ loading: false, authenticated: false, error: "Please log in to use the editor" });
        } else {
          setAuth({ loading: false, authenticated: false, error: "Authentication check failed" });
        }
      })
      .catch(() => {
        setAuth({ loading: false, authenticated: false, error: "Network error" });
      });
  }, []);

  // Load scenario from URL params on mount
  useEffect(() => {
    if (!auth.authenticated) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) {
      const scenarioId = parseInt(id, 10);
      scenario.loadScenario(scenarioId).then((result) => {
        if (result) {
          setNodes(result.nodes);
          setEdges(result.edges);
        }
      });
      // Load attachments
      loadAttachments(scenarioId);
    }
  }, [auth.authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load attachments for scenario
  const loadAttachments = useCallback(async (scenarioId: number) => {
    try {
      const res = await fetch(`/api/scenarios/${scenarioId}/attachments`);
      if (res.ok) {
        const data = await res.json();
        setAttachments(data.attachments ?? []);
      }
    } catch {
      // Silently fail - attachments are optional
    }
  }, []);

  // Upload file attachment
  const uploadFile = useCallback(async (file: File): Promise<AttachmentInfo | null> => {
    if (!scenario.scenarioId) return null;

    const reader = new FileReader();
    const base64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]); // Remove data:...;base64, prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const res = await fetch(`/api/scenarios/${scenario.scenarioId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "text/csv",
        data: base64,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Upload failed");
    }

    const data = await res.json();
    setAttachments((prev) => [...prev, data.attachment]);
    return data.attachment;
  }, [scenario.scenarioId]);

  // Delete attachment
  const deleteAttachment = useCallback(async (attachmentId: string): Promise<boolean> => {
    if (!scenario.scenarioId) return false;

    const res = await fetch(
      `/api/scenarios/${scenario.scenarioId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    );

    if (res.ok) {
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      return true;
    }
    return false;
  }, [scenario.scenarioId]);

  // Handle node selection
  const handleNodesChange = useCallback((newNodes: K6NodeType[]) => {
    setNodes(newNodes);
    const selected = newNodes.find((n) => n.selected);
    setSelectedNode(selected ?? null);
  }, []);

  // Update node parameters
  const updateNodeParameters = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (nodeId: string, parameters: any) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, parameters } as K6NodeData }
            : node,
        ),
      );
    },
    [],
  );

  // Close config panel
  const closeConfigPanel = useCallback(() => {
    setSelectedNode(null);
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
  }, []);

  // Get available HTTP request nodes for response validation
  const getHttpRequestNodes = useCallback(() => {
    return nodes
      .filter((n) => n.data.kind === "http-request")
      .map((n) => ({ id: n.id, label: n.data.label }));
  }, [nodes]);

  // Save scenario
  const handleSave = useCallback(async () => {
    if (scenario.scenarioId) {
      // Update existing
      const success = await scenario.updateScenario(
        scenario.scenarioId,
        scenario.scenarioName,
        nodes,
        edges,
      );
      if (success) {
        // Update URL without reload
        const url = new URL(window.location.href);
        url.searchParams.set("id", scenario.scenarioId.toString());
        window.history.replaceState({}, "", url.toString());
      }
    } else {
      // Show save dialog for new scenario
      setScenarioNameInput("");
      setShowSaveDialog(true);
    }
  }, [scenario, nodes, edges]);

  // Create new scenario
  const handleCreateScenario = useCallback(async () => {
    if (!scenarioNameInput.trim()) return;
    const result = await scenario.saveScenario(scenarioNameInput.trim(), nodes, edges);
    if (result) {
      setShowSaveDialog(false);
      // Update URL without reload
      const url = new URL(window.location.href);
      url.searchParams.set("id", result.id.toString());
      window.history.replaceState({}, "", url.toString());
    }
  }, [scenario, scenarioNameInput, nodes, edges]);

  // New scenario
  const handleNew = useCallback(() => {
    scenario.clearScenario();
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    // Clear URL param
    const url = new URL(window.location.href);
    url.searchParams.delete("id");
    window.history.replaceState({}, "", url.toString());
  }, [scenario]);

  // Run scenario
  const handleRun = useCallback(async () => {
    if (nodes.length === 0) {
      return;
    }

    // Fetch attachment data for run
    const runAttachments = await Promise.all(
      attachments.map(async (att) => {
        if (!scenario.scenarioId) return null;
        try {
          const res = await fetch(
            `/api/scenarios/${scenario.scenarioId}/attachments/${att.id}`,
          );
          if (res.ok) {
            const data = await res.json();
            return {
              id: data.attachment.id,
              name: data.attachment.name,
              data: data.attachment.data,
            };
          }
        } catch {
          // Skip failed attachments
        }
        return null;
      }),
    );

    const validAttachments = runAttachments.filter(
      (a): a is NonNullable<typeof a> => a !== null,
    );

    const result = await run.startRun(nodes, edges, {
      vus: 1,
      durationMs: 30000,
      attachments: validAttachments,
    });
    if (result.success && result.runId) {
      // Navigate to run metrics page
      router.push(`/runs/${result.runId}`);
    }
  }, [nodes, edges, run, router, attachments, scenario.scenarioId]);

  // Loading state
  if (auth.loading) {
    return (
      <div style={containerStyle}>
        <div style={messageStyle}>Loading...</div>
      </div>
    );
  }

  // Unauthenticated state
  if (!auth.authenticated) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Scenario Editor</h1>
          <p style={errorStyle}>{auth.error}</p>
          <a href="/" style={linkStyle}>
            ← Back to home
          </a>
        </div>
      </div>
    );
  }

  // Render config panel for selected node
  const renderConfigPanel = () => {
    if (!selectedNode) return null;

    const { kind, parameters } = selectedNode.data;
    const nodeId = selectedNode.id;

    switch (kind) {
      case "http-request":
        return (
          <HttpRequestConfigPanel
            parameters={parameters as Parameters<typeof HttpRequestConfigPanel>[0]["parameters"]}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "authentication":
        return (
          <AuthenticationConfigPanel
            parameters={parameters as Parameters<typeof AuthenticationConfigPanel>[0]["parameters"]}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "response-validation":
        return (
          <ResponseValidationConfigPanel
            parameters={parameters as Parameters<typeof ResponseValidationConfigPanel>[0]["parameters"]}
            availableNodes={getHttpRequestNodes()}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "user-pool":
        return (
          <UserPoolConfigPanel
            parameters={parameters as Parameters<typeof UserPoolConfigPanel>[0]["parameters"]}
            scenarioId={scenario.scenarioId}
            attachments={attachments}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
            onUploadFile={uploadFile}
            onDeleteAttachment={deleteAttachment}
          />
        );
      default:
        return null;
    }
  };

  // Editor
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h1 style={{ fontSize: "18px", fontWeight: 600, color: "#111827", margin: 0 }}>
            {scenario.scenarioName || "New Scenario"}
          </h1>
          {scenario.scenarioId && (
            <span style={{ fontSize: "12px", color: "#9ca3af" }}>#{scenario.scenarioId}</span>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {(scenario.error || run.error) && (
            <span style={{ fontSize: "13px", color: "#dc2626" }}>
              {scenario.error || run.error}
            </span>
          )}
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            {nodes.length} nodes, {edges.length} connections
          </span>
          <button onClick={handleNew} style={secondaryButtonStyle}>
            New
          </button>
          <button
            onClick={handleSave}
            disabled={scenario.saving || scenario.loading}
            style={primaryButtonStyle}
          >
            {scenario.saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={handleRun}
            disabled={run.running || nodes.length === 0 || run.orchestratorAvailable === false}
            style={runButtonStyle}
            title={run.orchestratorAvailable === false ? "Orchestrator not available" : "Run scenario"}
          >
            {run.running ? "Running..." : "▶ Run"}
          </button>
        </div>
      </header>

      {/* Loading overlay */}
      {scenario.loading && (
        <div style={loadingOverlayStyle}>
          <div style={messageStyle}>Loading scenario...</div>
        </div>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div style={dialogOverlayStyle}>
          <div style={dialogStyle}>
            <h2 style={{ margin: "0 0 16px", fontSize: "18px", fontWeight: 600 }}>
              Save Scenario
            </h2>
            <input
              type="text"
              value={scenarioNameInput}
              onChange={(e) => setScenarioNameInput(e.target.value)}
              placeholder="Scenario name"
              style={dialogInputStyle}
              autoFocus
            />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setShowSaveDialog(false)} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                onClick={handleCreateScenario}
                disabled={!scenarioNameInput.trim() || scenario.saving}
                style={primaryButtonStyle}
              >
                {scenario.saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Editor canvas */}
      <div style={{ flex: 1, position: "relative" }}>
        <FlowEditor
          initialNodes={nodes}
          initialEdges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={setEdges}
        />
        {renderConfigPanel()}
      </div>
    </div>
  );
}

// Styles
const containerStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f3f4f6",
  fontFamily: "system-ui, sans-serif",
};

const messageStyle: React.CSSProperties = {
  fontSize: "16px",
  color: "#6b7280",
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  padding: "32px",
  borderRadius: "12px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
  textAlign: "center",
  maxWidth: "400px",
};

const titleStyle: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: 600,
  color: "#111827",
  marginBottom: "12px",
};

const errorStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#dc2626",
  marginBottom: "16px",
};

const linkStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#2563eb",
  textDecoration: "none",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 20px",
  borderBottom: "1px solid #e5e7eb",
  background: "#fff",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#fff",
  background: "#2563eb",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#374151",
  background: "#f3f4f6",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};

const runButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#fff",
  background: "#16a34a",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const loadingOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(255,255,255,0.9)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};

const dialogStyle: React.CSSProperties = {
  background: "#fff",
  padding: "24px",
  borderRadius: "12px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  width: "400px",
  fontFamily: "system-ui, sans-serif",
};

const dialogInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "14px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  marginBottom: "16px",
  boxSizing: "border-box",
};
