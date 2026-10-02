"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendWindow,
  buildWsUrl,
  emptyWindowList,
  formatFailurePercent,
  formatLatency,
  formatRate,
  wsProtocols,
  type WindowList,
} from "../../../lib/live-metrics";

type Status = "idle" | "connecting" | "open" | "closed" | "run finished";

// Thin state shell: the repo has no testing library, so no component test is
// written — all behavior lives in lib/live-metrics (covered by
// live-metrics.test.ts); this file only holds React state and rendering.
export default function RunPage() {
  const { runId } = useParams<Record<string, string>>();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [list, setList] = useState<WindowList>(emptyWindowList);
  const socket = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close(4000, "client reconnect");
    }
    setStatus("connecting");
    setList(emptyWindowList()); // fresh session: manual reconnect, no replay (contract deferral)
    const ws = new WebSocket(buildWsUrl(window.location.origin, runId), wsProtocols(token));
    socket.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        parsed = undefined; // unparsable payload → counted as rejected by appendWindow
      }
      setList((prev) => appendWindow(prev, parsed));
    };
    ws.onclose = (event) => {
      if (socket.current !== ws) return; // superseded by a reconnect or closed by the client
      socket.current = null;
      // Clean close(1000) is the server's terminal signal; any other close is plain "closed".
      setStatus(event.code === 1000 ? "run finished" : "closed");
    };
  }, [runId, token]);

  const disconnect = useCallback(() => {
    // 4000 (application range) keeps 1000 reserved for the server's terminal signal.
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close(4000, "client disconnect");
      socket.current = null;
    }
    setStatus("closed");
  }, []);

  useEffect(() => () => {
    socket.current?.close(4000, "page unmount");
  }, []);

  const latest = list.frames[list.frames.length - 1];

  return (
    <main style={{ padding: 24, fontFamily: "monospace" }}>
      <h1 style={{ fontSize: 20 }}>Run {runId}</h1>

      <p style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label>
          WS token{" "}
          <input
            type="text"
            value={token}
            placeholder="service token"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button type="button" onClick={connect}>Connect</button>
        <button
          type="button"
          onClick={disconnect}
          disabled={status === "idle" || status === "closed" || status === "run finished"}
        >
          Disconnect
        </button>
        <span data-status={status} style={{ border: "1px solid #444", borderRadius: 4, padding: "2px 8px" }}>
          {status}
        </span>
        <span>rejected: {list.rejected}</span>
        {list.outOfOrder && <span>⚠ out-of-order seq</span>}
        {list.seqGaps > 0 && <span>seq gaps: {list.seqGaps}</span>}
      </p>

      <h2 style={{ fontSize: 16 }}>
        Current window{latest ? ` — seq ${latest.seq}, startMs ${latest.window.startMs}` : " —"}
      </h2>

      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["startMs", "req/s", "avg ms", "p90", "p95", "p99", "failure %", "activeVUs", "failedChecks"].map((head) => (
              <th key={head} style={{ border: "1px solid #333", padding: "4px 8px", textAlign: "left" }}>{head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.frames.map((frame) => (
            <tr key={`${frame.seq}-${frame.window.startMs}`}>
              <td style={cellStyle}>{frame.window.startMs}</td>
              <td style={cellStyle}>{formatRate(frame.reqPerSec)}</td>
              <td style={cellStyle}>{formatLatency(frame.latencyMs.avg)}</td>
              <td style={cellStyle}>{formatLatency(frame.latencyMs.p90)}</td>
              <td style={cellStyle}>{formatLatency(frame.latencyMs.p95)}</td>
              <td style={cellStyle}>{formatLatency(frame.latencyMs.p99)}</td>
              <td style={cellStyle}>{formatFailurePercent(frame.httpFailureFraction)}</td>
              <td style={cellStyle}>{frame.activeVUs}</td>
              <td style={cellStyle}>{frame.failedChecks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle = { border: "1px solid #333", padding: "4px 8px" };
