import { createServer } from "node:http";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WsServer } from "./ws-server";
import { RecordingSession } from "./recording-session";
import { CaptureWriter } from "./capture-writer";
import type { StreamingClientMessage } from "@k6flow/shared";

// Configuration from environment
const PORT = parseInt(process.env.PORT || "8081", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-token";
const START_URL = process.env.START_URL || "about:blank";
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "720", 10);
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS || "3600000", 10); // 1 hour default
const INACTIVITY_MS = parseInt(process.env.INACTIVITY_MS || "300000", 10); // 5 min default

// One recording session at a time; the process stays up between recordings.
let session: RecordingSession | null = null;
let captureWriter: CaptureWriter | null = null;
let recordingId: string | null = null;
let lastActivityTime = Date.now();
let inactivityTimer: NodeJS.Timeout | null = null;
let maxDurationTimer: NodeJS.Timeout | null = null;
let statsTimer: NodeJS.Timeout | null = null;

// Stats tracking
let framesSent = 0;
let framesDropped = 0;
let fpsCounter = 0;
let lastFpsTime = Date.now();
let currentFps = 0;

// CORS headers for development
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Create HTTP server
const httpServer = createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
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
      res.writeHead(401, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // If session exists, return it for reconnection
    if (session && recordingId) {
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({
        recordingId,
        status: "reconnected",
        wsUrl: `/ws/recordings/${recordingId}?token=${AUTH_TOKEN}`,
      }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const config = JSON.parse(body || "{}");
        const recId = config.recordingId || `rec-${Date.now()}`;
        recordingId = recId;

        // Create capture writer for persistence
        const outputDir = process.env.CAPTURE_DIR || "/tmp/captures";
        const writer = new CaptureWriter(outputDir, recId);
        captureWriter = writer;
        writer.start({
          recordingId: recId,
          startUrl: config.startUrl || START_URL,
          viewport: {
            width: config.viewportWidth || VIEWPORT_WIDTH,
            height: config.viewportHeight || VIEWPORT_HEIGHT,
          },
          startedAt: Date.now(),
          userAgent: config.userAgent,
        });

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
              const result = wsServer.sendFrame(recId, frame);
              framesSent += result.sent;
              framesDropped += result.dropped;
              fpsCounter++;
              
              // Always ack frame to keep CDP sending
              // Without ack, CDP stops sending frames
              session?.ackFrame(frame.seq);
            },
            onStateChange: (state) => {
              wsServer.broadcast(recId, { 
                t: "state", 
                state, 
                recordingId: recId 
              });
              writer.writeStateChange(state);
            },
            onNavigation: (url, title, canGoBack, canGoForward, loading) => {
              wsServer.broadcast(recId, { 
                t: "nav", 
                url, 
                title, 
                canGoBack, 
                canGoForward, 
                loading 
              });
              if (!loading) {
                writer.writeNavigation(url, title);
              }
            },
            onTabs: (tabs) => {
              wsServer.broadcast(recId, { 
                t: "tabs", 
                tabs 
              });
            },
            onDialog: (dialog) => {
              wsServer.broadcast(recId, { 
                t: "dialog", 
                kind: dialog.kind, 
                message: dialog.message,
                id: dialog.id,
                defaultValue: dialog.defaultValue
              });
            },
            onFileChooser: (info) => {
              wsServer.broadcast(recId, { 
                t: "filechooser", 
                id: info.id,
                multiple: info.multiple
              });
            },
            onCursor: (style) => {
              wsServer.broadcast(recId, { 
                t: "cursor", 
                style
              });
            },
            onNetworkRequest: (request) => {
              writer.writeNetworkRequest(request);
            },
            onNetworkEntry: (entry) => {
              writer.writeNetworkEntry(entry);
            },
            onUIEvent: (event) => {
              writer.writeUIEvent(event);
            },
            onStep: (step) => {
              // Broadcast step to clients
              wsServer.broadcast(recId, { 
                t: "step", 
                stepId: step.id,
                name: step.name,
                kind: step.kind,
                timestamp: step.timestamp
              });
              writer.writeStep(step);
            },
            onError: (error) => {
              console.error("Recording error:", error);
              wsServer.broadcast(recId, { 
                t: "error", 
                code: "recording_error", 
                message: error.message 
              });
            },
          }
        );

        await session.start();
        startTimers();

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ 
          recordingId,
          wsUrl: `/ws/recordings/${recordingId}?token=${AUTH_TOKEN}`,
        }));
      } catch (error) {
        console.error("Failed to start recording:", error);
        // Release the half-started session so the next /start is a fresh one.
        await stopRecording("start-failed").catch((stopError) => {
          console.error("Cleanup after failed start failed:", stopError);
        });
        res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: "Failed to start recording" }));
      }
    });
    return;
  }

  // Stop recording endpoint
  if (req.method === "POST" && req.url === "/stop") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    stopRecording("manual").then(() => {
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ status: "stopped" }));
    }).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  // File upload endpoint for file chooser
  if (req.method === "POST" && req.url === "/upload") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json", ...corsHeaders });
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
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ assetId }));
    });

    writeStream.on("error", (error) => {
      console.error("Upload error:", error);
      res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
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

  // Stop goes through the full teardown so the capture is written and state resets.
  if (message.t === "stop") {
    await stopRecording("manual");
    return;
  }

  // Messages handled by session
  if (["mouse", "key", "text", "nav", "pause", "resume", "resize"].includes(message.t)) {
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
  // Per-recording baselines; a reused process must not inherit the previous session's.
  lastActivityTime = Date.now();
  lastFpsTime = Date.now();
  fpsCounter = 0;

  // FPS counter
  statsTimer = setInterval(() => {
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

  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  if (captureWriter) {
    captureWriter.end(reason);
    console.log(`Capture written to: ${captureWriter.path} (${captureWriter.count} events)`);
    captureWriter = null;
  }

  const endingId = recordingId;
  if (session) {
    // Detach first so a concurrent stop is a no-op. Session callbacks are bound
    // to their own recordingId, so late events from `ending` cannot leak into a
    // recording started while it shuts down.
    const ending = session;
    session = null;
    await ending.stop();
  }
  // Only clear the id if no new recording took over during the await.
  if (recordingId === endingId && !session) {
    recordingId = null;
  }
}

// Graceful shutdown: only process signals end the process.
async function shutdown(reason: string): Promise<void> {
  try {
    await stopRecording(reason);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("sigterm"));
process.on("SIGINT", () => void shutdown("sigint"));

// Start server
httpServer.listen(PORT, () => {
  console.log(`Recorder server listening on port ${PORT}`);
});
