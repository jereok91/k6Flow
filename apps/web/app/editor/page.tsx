"use client";

// K6F4-05b/c: Visual scenario editor page.
// Authenticated users only. Scenario loading/saving handled in K6F4-06.

import { useState, useEffect, useCallback } from "react";
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

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  error?: string;
}

export default function EditorPage() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [nodes, setNodes] = useState<K6NodeType[]>([]);
  const [edges, setEdges] = useState<K6Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<K6NodeType | null>(null);

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

  // Handle node selection
  const handleNodesChange = useCallback((newNodes: K6NodeType[]) => {
    setNodes(newNodes);
    // Find selected node
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
    // Deselect all nodes
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
  }, []);

  // Get available HTTP request nodes for response validation
  const getHttpRequestNodes = useCallback(() => {
    return nodes
      .filter((n) => n.data.kind === "http-request")
      .map((n) => ({ id: n.id, label: n.data.label }));
  }, [nodes]);

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
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
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
        <h1 style={{ fontSize: "18px", fontWeight: 600, color: "#111827", margin: 0 }}>
          Scenario Editor
        </h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            {nodes.length} nodes, {edges.length} connections
          </span>
          {/* Save button will be wired in K6F4-06 */}
          <button
            style={buttonStyle}
            disabled
            title="Save functionality coming in K6F4-06"
          >
            Save
          </button>
        </div>
      </header>

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

const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#fff",
  background: "#2563eb",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  opacity: 0.5,
};
