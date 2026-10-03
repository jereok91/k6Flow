"use client";

// K6F7-08: Recorder UI page.
// K6F8-04: Import to editor flow.

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface CaptureEntry {
  method: string;
  url: string;
  status: number;
  headers: { name: string; value: string }[];
  bodyExcerpt?: string;
  redacted: boolean;
}

interface WsMessage {
  version: number;
  type: "status" | "capture" | "error";
  status?: string;
  entry?: CaptureEntry;
  code?: string;
  message?: string;
}

type RecordingStatus = "idle" | "pending" | "recording" | "stopping" | "completed" | "failed";

export default function RecorderPage() {
  const router = useRouter();
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<CaptureEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [proxyUrl, setProxyUrl] = useState("http://localhost:8082");
  const wsRef = useRef<WebSocket | null>(null);

  // K6F8-04: Import captures to editor
  const importToEditor = () => {
    if (captures.length === 0) return;
    // Store captures in sessionStorage for the editor to pick up
    sessionStorage.setItem("k6flow-import-captures", JSON.stringify(captures));
    router.push("/editor?import=true");
  };

  const connectWs = useCallback((id: string) => {
    // Use same-origin WebSocket (proxied through Next.js)
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/recordings/${id}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ version: 1, type: "init" }));
    };

    ws.onmessage = (event) => {
      const msg: WsMessage = JSON.parse(event.data);
      if (msg.type === "status" && msg.status) {
        setStatus(msg.status as RecordingStatus);
      } else if (msg.type === "capture" && msg.entry) {
        setCaptures((prev) => [...prev, msg.entry!]);
      } else if (msg.type === "error") {
        setError(msg.message || "WebSocket error");
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    wsRef.current = ws;
  }, []);

  const startRecording = async () => {
    setError(null);
    setCaptures([]);

    try {
      const res = await fetch("/api/recorder/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.message || "Failed to start recording");
        return;
      }

      const data = await res.json();
      setRecordingId(data.recordingId);
      setStatus("pending");
      connectWs(data.recordingId);
    } catch (err) {
      setError("Network error starting recording");
    }
  };

  const stopRecording = async () => {
    if (!recordingId) return;

    try {
      const res = await fetch(
        `/api/recorder/recordings/${recordingId}/stop`,
        { method: "POST" }
      );

      if (res.ok) {
        const data = await res.json();
        setStatus(data.status as RecordingStatus);
        setCaptures(data.capture || []);
      }
    } catch (err) {
      setError("Failed to stop recording");
    }

    wsRef.current?.close();
  };

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return (
    <main style={containerStyle}>
      <header style={headerStyle}>
        <Link href="/" style={backLinkStyle}>← Home</Link>
        <h1 style={titleStyle}>Traffic Recorder</h1>
      </header>

      <section style={sectionStyle}>
        <div style={controlsStyle}>
          <div style={statusBadgeStyle(status)}>
            {status.toUpperCase()}
          </div>

          {status === "idle" || status === "completed" || status === "failed" ? (
            <button onClick={startRecording} style={buttonStyle}>
              Start Recording
            </button>
          ) : (
            <button onClick={stopRecording} style={stopButtonStyle}>
              Stop Recording
            </button>
          )}
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        {(status === "recording" || status === "pending") && (
          <div style={proxyInfoStyle}>
            <strong>Configure your HTTP client to use this proxy:</strong>
            <code style={codeStyle}>{proxyUrl}</code>
            <p style={hintStyle}>
              Example: <code>HTTP_PROXY={proxyUrl} curl https://example.com</code>
            </p>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>
          Captured Requests ({captures.length})
        </h2>

        {captures.length === 0 ? (
          <p style={emptyStyle}>No requests captured yet.</p>
        ) : (
          <>
            <div style={captureListStyle}>
              {captures.map((entry, idx) => (
                <div key={idx} style={captureItemStyle}>
                  <div style={captureHeaderStyle}>
                    <span style={methodStyle(entry.method)}>{entry.method}</span>
                    <span style={statusCodeStyle(entry.status)}>{entry.status}</span>
                    <span style={urlStyle}>{entry.url}</span>
                  </div>
                  {entry.bodyExcerpt && (
                    <pre style={bodyStyle}>{entry.bodyExcerpt}</pre>
                  )}
                </div>
              ))}
            </div>

            {/* K6F8-04: Import to editor button */}
            <div style={importSectionStyle}>
              <button onClick={importToEditor} style={importButtonStyle}>
                Import to Editor →
              </button>
              <span style={importHintStyle}>
                Convert {captures.length} captured request{captures.length > 1 ? 's' : ''} to graph nodes
              </span>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

// Styles
const containerStyle: React.CSSProperties = {
  minHeight: "100vh",
  fontFamily: "system-ui, sans-serif",
  background: "#f9fafb",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 24px",
  background: "#fff",
  borderBottom: "1px solid #e5e7eb",
  display: "flex",
  alignItems: "center",
  gap: "16px",
};

const backLinkStyle: React.CSSProperties = {
  color: "#6b7280",
  textDecoration: "none",
  fontSize: "14px",
};

const titleStyle: React.CSSProperties = {
  fontSize: "20px",
  fontWeight: 600,
  margin: 0,
};

const sectionStyle: React.CSSProperties = {
  maxWidth: "900px",
  margin: "0 auto",
  padding: "24px",
};

const controlsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
  marginBottom: "16px",
};

const statusBadgeStyle = (status: RecordingStatus): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: "4px",
  fontSize: "12px",
  fontWeight: 600,
  background:
    status === "recording" ? "#dcfce7" :
    status === "failed" ? "#fef2f2" :
    status === "completed" ? "#dbeafe" :
    "#f3f4f6",
  color:
    status === "recording" ? "#166534" :
    status === "failed" ? "#dc2626" :
    status === "completed" ? "#1d4ed8" :
    "#374151",
});

const buttonStyle: React.CSSProperties = {
  padding: "10px 20px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#fff",
  background: "#2563eb",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const stopButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#dc2626",
};

const errorStyle: React.CSSProperties = {
  padding: "12px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  color: "#dc2626",
  fontSize: "14px",
  marginBottom: "16px",
};

const proxyInfoStyle: React.CSSProperties = {
  padding: "16px",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
};

const codeStyle: React.CSSProperties = {
  display: "block",
  padding: "8px 12px",
  background: "#1e293b",
  color: "#f1f5f9",
  borderRadius: "4px",
  fontSize: "14px",
  margin: "8px 0",
};

const hintStyle: React.CSSProperties = {
  fontSize: "13px",
  color: "#6b7280",
  margin: 0,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  margin: "0 0 16px",
};

const emptyStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontStyle: "italic",
};

const captureListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const captureItemStyle: React.CSSProperties = {
  padding: "12px",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: "6px",
};

const captureHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const methodStyle = (method: string): React.CSSProperties => ({
  padding: "2px 6px",
  borderRadius: "4px",
  fontSize: "12px",
  fontWeight: 600,
  background:
    method === "GET" ? "#dbeafe" :
    method === "POST" ? "#dcfce7" :
    method === "PUT" ? "#fef3c7" :
    method === "DELETE" ? "#fef2f2" :
    "#f3f4f6",
  color:
    method === "GET" ? "#1d4ed8" :
    method === "POST" ? "#166534" :
    method === "PUT" ? "#b45309" :
    method === "DELETE" ? "#dc2626" :
    "#374151",
});

const statusCodeStyle = (status: number): React.CSSProperties => ({
  fontSize: "12px",
  fontWeight: 500,
  color: status < 300 ? "#166534" : status < 400 ? "#b45309" : "#dc2626",
});

const urlStyle: React.CSSProperties = {
  fontSize: "13px",
  color: "#374151",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
};

const bodyStyle: React.CSSProperties = {
  marginTop: "8px",
  padding: "8px",
  background: "#f9fafb",
  borderRadius: "4px",
  fontSize: "12px",
  overflow: "auto",
  maxHeight: "100px",
};

// K6F8-04: Import styles
const importSectionStyle: React.CSSProperties = {
  marginTop: "24px",
  padding: "16px",
  background: "#f0fdf4",
  borderRadius: "8px",
  border: "1px solid #bbf7d0",
  display: "flex",
  alignItems: "center",
  gap: "16px",
};

const importButtonStyle: React.CSSProperties = {
  padding: "12px 24px",
  fontSize: "14px",
  fontWeight: 600,
  color: "#fff",
  background: "#16a34a",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const importHintStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#166534",
};
