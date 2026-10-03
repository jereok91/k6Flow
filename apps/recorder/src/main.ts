import { createServer } from "node:http";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WsServer } from "./ws-server";
import { RecordingSession } from "./recording-session";
import type { StreamingClientMessage } from "@k6flow/shared";

// Configuration from environment
const PORT = parseInt(process.env.PORT || "8081", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-token";
const START_URL = process.env.START_URL || "about:blank";
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "720", 10);
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS || "3600000", 10); // 1 hour default
const INACTIVITY_MS = parseInt(process.env.INACTIVITY_MS || "300000", 10); // 5 min default

// Single recording session per container (orchestrator spawns one container per recording)
let session: RecordingSession | null = null;
let recordingId: string | null = null;
let lastActivityTime = Date.now();
let inactivityTimer: NodeJS.Timeout | null = null;
let maxDurationTimer: NodeJS.Timeout | null = null;

// Stats tracking
let framesSent = 0;
let framesDropped = 0;
let fpsCounter = 0;
let lastFpsTime = Date.now();
let currentFps = 0;

// Create HTTP server
const httpServer = createServer((req, res) => {
  // Health check endpoint
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      status: "ok", 
      recordingId,
      state: session?.currentState ?? "idle",
      durationMs: session?.durationMs ?? 0,
    }));
    return;
  }

  // Start recording endpoint
  if (req.method === "POST" && req.url === "/start") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (session) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Recording already in progress" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const config = JSON.parse(body || "{}");
        recordingId = config.recordingId || `rec-${Date.now()}`;

        session = new RecordingSession(
          {
            startUrl: config.startUrl || START_URL,
            viewport: { 
              width: config.viewportWidth || VIEWPORT_WIDTH, 
              height: config.viewportHeight || VIEWPORT_HEIGHT 
            },
            userAgent: config.userAgent,
            locale: config.locale,
            timezone: config.timezone,
          },
          {
            onFrame: (frame) => {
              const result = wsServer.sendFrame(recordingId!, frame);
              framesSent += result.sent;
              framesDropped += result.dropped;
              fpsCounter++;
              
              // Always ack frame to keep CDP sending
              // Without ack, CDP stops sending frames
              session?.ackFrame(frame.seq);
            },
            onStateChange: (state) => {
              wsServer.broadcast(recordingId!, { 
                t: "state", 
                state, 
                recordingId: recordingId! 
              });
            },
            onNavigation: (url, title, canGoBack, canGoForward, loading) => {
              wsServer.broadcast(recordingId!, { 
                t: "nav", 
                url, 
                title, 
                canGoBack, 
                canGoForward, 
                loading 
              });
            },
            onTabs: (tabs) => {
              wsServer.broadcast(recordingId!, { 
                t: "tabs", 
                tabs 
              });
            },
            onDialog: (dialog) => {
              wsServer.broadcast(recordingId!, { 
                t: "dialog", 
                kind: dialog.kind, 
                message: dialog.message,
                id: dialog.id,
                defaultValue: dialog.defaultValue
              });
            },
            onFileChooser: (info) => {
              wsServer.broadcast(recordingId!, { 
                t: "filechooser", 
                id: info.id,
                multiple: info.multiple
              });
            },
            onCursor: (style) => {
              wsServer.broadcast(recordingId!, { 
                t: "cursor", 
                style
              });
            },
            onError: (error) => {
              console.error("Recording error:", error);
              wsServer.broadcast(recordingId!, { 
                t: "error", 
                code: "recording_error", 
                message: error.message 
              });
            },
          }
        );

        await session.start();
        startTimers();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          recordingId,
          wsUrl: `/ws/recordings/${recordingId}?token=${AUTH_TOKEN}`,
        }));
      } catch (error) {
        console.error("Failed to start recording:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to start recording" }));
      }
    });
    return;
  }

  // Stop recording endpoint
  if (req.method === "POST" && req.url === "/stop") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    stopRecording("manual").then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "stopped" }));
    }).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  // File upload endpoint for file chooser
  if (req.method === "POST" && req.url === "/upload") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Ensure upload directory exists
    const uploadDir = "/tmp/uploads";
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const assetId = randomUUID();
    const filePath = `${uploadDir}/${assetId}`;
    const writeStream = createWriteStream(filePath);

    req.pipe(writeStream);

    writeStream.on("finish", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ assetId }));
    });

    writeStream.on("error", (error) => {
      console.error("Upload error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upload failed" }));
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

// Create WebSocket server
const wsServer = new WsServer(
  { authToken: AUTH_TOKEN },
  {
    onConnect: (recId, _ws) => {
      console.log(`Client connected to recording ${recId}`);
      lastActivityTime = Date.now();

      // Send current state
      if (session && recId === recordingId) {
        wsServer.broadcast(recId, { 
          t: "state", 
          state: session.currentState, 
          recordingId: recId 
        });
      }
    },
    onMessage: async (recId, message) => {
      lastActivityTime = Date.now();

      if (recId !== recordingId || !session) {
        return;
      }

      await handleClientMessage(message);
    },
    onDisconnect: (recId) => {
      console.log(`All clients disconnected from ${recId}`);
      // Don't stop immediately - allow reconnection window
    },
  }
);

wsServer.attach(httpServer);

// Handle client messages
async function handleClientMessage(message: StreamingClientMessage): Promise<void> {
  console.log(`[Input] Received message: ${message.t}`, message);
  
  if (!session) {
    console.log(`[Input] No session, ignoring`);
    return;
  }

  // Messages handled by session
  if (["mouse", "key", "text", "nav", "pause", "resume", "stop", "resize"].includes(message.t)) {
    console.log(`[Input] Forwarding to session`);
    await session.handleInput(message);
  }

  // Mark message - TODO: implement step marking
  if (message.t === "mark") {
    console.log(`Step marked: ${message.kind} - ${message.name}`);
  }
}

// Timers
function startTimers(): void {
  // FPS counter
  setInterval(() => {
    const now = Date.now();
    const elapsed = (now - lastFpsTime) / 1000;
    currentFps = Math.round(fpsCounter / elapsed);
    fpsCounter = 0;
    lastFpsTime = now;

    // Broadcast stats
    if (recordingId && session) {
      const stats = wsServer.getStats(recordingId);
      wsServer.broadcast(recordingId, {
        t: "stats",
        fps: currentFps,
        quality: session.currentQuality,
        rttMs: 0, // TODO: measure from ping/pong
        droppedFrames: stats.totalDropped,
        recordedRequests: 0, // TODO: from network capture
      });
    }
  }, 1000);

  // Inactivity timer
  inactivityTimer = setInterval(() => {
    if (!wsServer.hasClients(recordingId!)) {
      const idleTime = Date.now() - lastActivityTime;
      if (idleTime > INACTIVITY_MS) {
        console.log("Stopping due to inactivity");
        stopRecording("inactivity");
      }
    }
  }, 10000);

  // Max duration timer
  maxDurationTimer = setTimeout(() => {
    console.log("Stopping due to max duration");
    stopRecording("max-duration");
  }, MAX_DURATION_MS);
}

async function stopRecording(reason: string): Promise<void> {
  console.log(`Stopping recording: ${reason}`);

  if (inactivityTimer) {
    clearInterval(inactivityTimer);
    inactivityTimer = null;
  }

  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  }

  if (session) {
    await session.stop();
    session = null;
  }

  // Exit the container
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// Graceful shutdown
process.on("SIGTERM", () => stopRecording("sigterm"));
process.on("SIGINT", () => stopRecording("sigint"));

// Start server
httpServer.listen(PORT, () => {
  console.log(`Recorder server listening on port ${PORT}`);
});
