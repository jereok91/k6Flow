import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import {
  streamingClientMessageSchema,
  type StreamingServerMessage,
  type StreamingClientMessage,
} from "@k6flow/shared";
import type { ScreencastFrame } from "./screencast";
import { encodeFrame } from "./screencast";

export interface WsServerConfig {
  authToken: string;
  maxBufferedAmount: number; // bytes
  reconnectWindowMs: number;
}

export interface WsServerCallbacks {
  onConnect: (recordingId: string, ws: WebSocket) => void;
  onMessage: (recordingId: string, message: StreamingClientMessage) => void;
  onDisconnect: (recordingId: string) => void;
}

interface ClientState {
  ws: WebSocket;
  recordingId: string;
  isController: boolean;
  droppedFrames: number;
  lastFrameSeq: number;
  pendingAcks: Set<number>;
}

const DEFAULT_CONFIG: WsServerConfig = {
  authToken: "",
  maxBufferedAmount: 256 * 1024, // 256KB
  reconnectWindowMs: 30_000,
};

/**
 * WebSocket server for recorder streaming.
 * Handles binary frames and JSON control messages.
 */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private recordingClients = new Map<string, Set<WebSocket>>();
  private config: WsServerConfig;
  private callbacks: WsServerCallbacks;

  constructor(config: Partial<WsServerConfig>, callbacks: WsServerCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const result = this.authenticate(request);
      if (!result.ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.handleConnection(ws, result.recordingId, result.isController);
      });
    });
  }

  private authenticate(request: IncomingMessage): { ok: false } | { ok: true; recordingId: string; isController: boolean } {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const pathMatch = url.pathname.match(/^\/ws\/recordings\/([^/]+)$/);
    if (!pathMatch) return { ok: false };

    const recordingId = pathMatch[1];
    const token = url.searchParams.get("token");
    
    // Simple token validation - in production this would be a signed JWT
    if (token !== this.config.authToken) {
      return { ok: false };
    }

    const role = url.searchParams.get("role");
    const isController = role !== "viewer";

    return { ok: true, recordingId, isController };
  }

  private handleConnection(ws: WebSocket, recordingId: string, isController: boolean): void {
    const state: ClientState = {
      ws,
      recordingId,
      isController,
      droppedFrames: 0,
      lastFrameSeq: 0,
      pendingAcks: new Set(),
    };

    this.clients.set(ws, state);
    
    if (!this.recordingClients.has(recordingId)) {
      this.recordingClients.set(recordingId, new Set());
    }
    this.recordingClients.get(recordingId)!.add(ws);

    this.callbacks.onConnect(recordingId, ws);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Binary messages from client are not expected in this protocol
        return;
      }

      try {
        const json = JSON.parse(data.toString());
        const parsed = streamingClientMessageSchema.safeParse(json);
        if (!parsed.success) {
          this.sendJson(ws, { t: "error", code: "invalid_message", message: parsed.error.message });
          return;
        }

        // Only controllers can send input
        if (!isController && ["mouse", "key", "text", "nav", "tab", "dialog_reply", "file_upload", "mark", "pause", "resume", "stop"].includes(parsed.data.t)) {
          this.sendJson(ws, { t: "error", code: "not_controller", message: "Viewers cannot send input" });
          return;
        }

        // Handle ping locally
        if (parsed.data.t === "ping") {
          this.sendJson(ws, { t: "pong", ts: parsed.data.ts });
          return;
        }

        this.callbacks.onMessage(recordingId, parsed.data);
      } catch {
        this.sendJson(ws, { t: "error", code: "parse_error", message: "Invalid JSON" });
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      const clients = this.recordingClients.get(recordingId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          this.recordingClients.delete(recordingId);
          this.callbacks.onDisconnect(recordingId);
        }
      }
    });

    ws.on("error", () => {
      ws.close();
    });
  }

  /**
   * Send a binary frame to all clients of a recording.
   * Implements backpressure: drops frames if buffer is full.
   */
  sendFrame(recordingId: string, frame: ScreencastFrame): { sent: number; dropped: number } {
    const clients = this.recordingClients.get(recordingId);
    if (!clients) return { sent: 0, dropped: 0 };

    const encoded = encodeFrame(frame);
    let sent = 0;
    let dropped = 0;

    for (const ws of clients) {
      const state = this.clients.get(ws);
      if (!state) continue;

      // Backpressure: drop frame if buffer is too full
      if (ws.bufferedAmount > this.config.maxBufferedAmount) {
        state.droppedFrames++;
        dropped++;
        continue;
      }

      ws.send(encoded, { binary: true });
      state.lastFrameSeq = frame.seq;
      state.pendingAcks.add(frame.seq);
      sent++;
    }

    return { sent, dropped };
  }

  /**
   * Send a JSON message to all clients of a recording.
   */
  broadcast(recordingId: string, message: StreamingServerMessage): void {
    const clients = this.recordingClients.get(recordingId);
    if (!clients) return;

    const json = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  /**
   * Send a JSON message to a specific client.
   */
  private sendJson(ws: WebSocket, message: StreamingServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get stats for a recording.
   */
  getStats(recordingId: string): { clientCount: number; totalDropped: number } {
    const clients = this.recordingClients.get(recordingId);
    if (!clients) return { clientCount: 0, totalDropped: 0 };

    let totalDropped = 0;
    for (const ws of clients) {
      const state = this.clients.get(ws);
      if (state) totalDropped += state.droppedFrames;
    }

    return { clientCount: clients.size, totalDropped };
  }

  /**
   * Check if a recording has any connected clients.
   */
  hasClients(recordingId: string): boolean {
    const clients = this.recordingClients.get(recordingId);
    return clients ? clients.size > 0 : false;
  }

  close(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
    this.recordingClients.clear();
  }
}
