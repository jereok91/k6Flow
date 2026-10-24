import { createServer } from "node:http";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WsServer } from "./ws-server";
import { RecordingSession } from "./recording-session";
import { CaptureWriter } from "./capture-writer";
import { readCapture, removeCapture } from "./capture-store";
import type { StreamingClientMessage } from "@k6flow/shared";

// Configuration from environment
const PORT = parseInt(process.env.PORT || "8081", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-token";
const START_URL = process.env.START_URL || "about:blank";
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "720", 10);
const MAX_DURATION_MS = parseInt(process.env.MAX_DURATION_MS || "3600000", 10); // 1 hour default
const INACTIVITY_MS = parseInt(process.env.INACTIVITY_MS || "300000", 10); // 5 min default
const CAPTURE_DIR = process.env.CAPTURE_DIR || "/tmp/captures";
/** Longest a browser teardown may take before the capture is closed anyway. */
const BROWSER_STOP_TIMEOUT_MS = parseInt(process.env.BROWSER_STOP_TIMEOUT_MS || "10000", 10);

/**
 * Resolve with `work`, or reject once `ms` passes. A late result is ignored.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// One recording session at a time; the process stays up between recordings.
let session: RecordingSession | null = null;
let captureWriter: CaptureWriter | null = null;
let recordingId: string | null = null;
let lastActivityTime = Date.now();
let inactivityTimer: NodeJS.Timeout | null = null;
let maxDurationTimer: NodeJS.Timeout | null = null;
let statsTimer: NodeJS.Timeout | null = null;
// Ids are single-use per process: an old WebSocket or capture file can never alias a new recording.
const usedRecordingIds = new Set<string>();
// Pending teardown; a new start waits for it so two sessions never overlap.
let stopping: Promise<void> | null = null;
/** The teardown currently running, shared by every caller that stops at once. */
let inFlightTeardown: Promise<TeardownResult> | null = null;

/** What a teardown actually ended, reported back to whoever asked for the stop. */
interface TeardownResult {
  recordingId: string | null;
  events: number;
  durationMs: number;
  reason: string;
}

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
        await stopping;
        const config = JSON.parse(body || "{}");
        const recId = config.recordingId || `rec-${Date.now()}`;
        if (usedRecordingIds.has(recId)) {
          res.writeHead(409, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ error: "Recording id already used" }));
          return;
        }
        usedRecordingIds.add(recId);
        recordingId = recId;

        // Create capture writer for persistence
        const writer = new CaptureWriter(CAPTURE_DIR, recId);
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

        // Callbacks act on their own session, never on whichever one is current.
        let owner: RecordingSession | null = null;
        session = owner = new RecordingSession(
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
              if (owner === session) {
                framesSent += result.sent;
                framesDropped += result.dropped;
                fpsCounter++;
              }
              
              // Always ack frame to keep CDP sending
              // Without ack, CDP stops sending frames
              owner?.ackFrame(frame.seq);
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

        await owner.start();
        startTimers();

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ 
          recordingId: recId,
          wsUrl: `/ws/recordings/${recId}?token=${AUTH_TOKEN}`,
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

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let requestedId: string | null = null;
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed.recordingId === "string" && parsed.recordingId !== "") {
          requestedId = parsed.recordingId;
        }
      } catch {
        // An empty or malformed body means "stop whatever is running".
      }

      // A stop may only end the recording it names: stopping someone else's
      // session would truncate a capture the caller never asked about.
      if (requestedId !== null && recordingId !== null && requestedId !== recordingId) {
        res.writeHead(409, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: "Recording mismatch", recordingId }));
        return;
      }

      stopRecording("manual").then((result) => {
        const endedId = result.recordingId ?? requestedId;
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({
          // "idle" means no session was running: the caller's id is echoed back so a
          // capture written by an earlier automatic stop can still be collected.
          status: result.recordingId === null ? "idle" : "stopped",
          recordingId: endedId,
          events: result.events,
          durationMs: result.durationMs,
          reason: result.reason,
        }));
      }).catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: error.message }));
      });
    });
    return;
  }

  // Finished capture download: the web tier persists it and the review screen
  // reads it back, so a stop can be reviewed without hunting for a local file.
  if ((req.method === "GET" || req.method === "DELETE") && req.url?.startsWith("/captures/")) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let requestedId: string;
    try {
      requestedId = decodeURIComponent(req.url.slice("/captures/".length).split("?")[0]);
    } catch {
      requestedId = "";
    }

    if (req.method === "DELETE") {
      // The library now owns the capture: deleting it keeps the volume from
      // growing with recordings that are already persisted.
      if (!removeCapture(CAPTURE_DIR, requestedId)) {
        res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: "Capture not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ status: "deleted", recordingId: requestedId }));
      return;
    }

    // readCapture validates the id before it can reach the filesystem and never
    // throws: an unreadable capture is a 404 for this request, not a dead process.
    let capture: string | null = null;
    try {
      capture = readCapture(CAPTURE_DIR, requestedId);
    } catch (error) {
      console.error("Capture read failed:", error);
    }
    if (capture === null) {
      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Capture not found" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Content-Length": Buffer.byteLength(capture),
      ...corsHeaders,
    });
    res.end(capture);
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

      await handleClientMessage(recId, message);
    },
    onDisconnect: (recId) => {
      console.log(`All clients disconnected from ${recId}`);
      // Don't stop immediately - allow reconnection window
    },
  }
);

wsServer.attach(httpServer);

// Handle client messages
async function handleClientMessage(recId: string, message: StreamingClientMessage): Promise<void> {
  console.log(`[Input] Received message: ${message.t}`, message);
  
  if (!session) {
    console.log(`[Input] No session, ignoring`);
    return;
  }

  // Stop goes through the full teardown so the capture is written and state resets.
  if (message.t === "stop") {
    // A connection may only stop the recording it was opened for.
    if (recId !== recordingId) return;
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
        void stopRecording("inactivity").catch((error) => console.error("Idle stop failed:", error));
      }
    }
  }, 10000);

  // Max duration timer
  maxDurationTimer = setTimeout(() => {
    console.log("Stopping due to max duration");
    void stopRecording("max-duration").catch((error) => console.error("Max-duration stop failed:", error));
  }, MAX_DURATION_MS);
}

function stopRecording(reason: string): Promise<TeardownResult> {
  // A duplicate stop joins the teardown already running: a second teardown would
  // close the capture writer under the first one and truncate the capture.
  if (inFlightTeardown !== null) return inFlightTeardown;

  const run = teardown(reason);
  inFlightTeardown = run;
  const clearInFlight = () => {
    if (inFlightTeardown === run) inFlightTeardown = null;
  };
  run.then(clearInFlight, clearInFlight);

  const tracked: Promise<void> = run.then(() => {}, () => {}).then(() => {
    if (stopping === tracked) stopping = null;
  });
  stopping = tracked;
  return run;
}

async function teardown(reason: string): Promise<TeardownResult> {
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

  const endingId = recordingId;
  // Own the writer before the first await: whatever happens next, this teardown
  // closes the capture it started with, never a later recording's.
  const writer = captureWriter;
  captureWriter = null;

  let durationMs = 0;
  let events = 0;
  let failure: unknown = null;

  try {
    if (session) {
      // Detach first so a concurrent stop joins this teardown. Session callbacks are
      // bound to their own recordingId, so late events from `ending` cannot leak into
      // a recording started while it shuts down.
      const ending = session;
      session = null;
      durationMs = ending.durationMs;
      // The browser teardown is bounded: a hung close must not keep the capture
      // open forever, which would leave the stop request without an answer.
      await withTimeout(ending.stop(), BROWSER_STOP_TIMEOUT_MS);
    }
  } catch (error) {
    // A failed browser teardown must not keep the capture open: the writer is
    // still closed below, and the stop answers with the failure.
    failure = error;
  }

  try {
    // Close the capture last, after the session stopped emitting events, and wait
    // for the flush: a stop that answers before the file is on disk would let the
    // caller read a truncated capture. A flush failure rejects instead of passing
    // as success.
    if (writer) {
      await writer.end(reason);
      events = writer.count;
      console.log(`Capture written to: ${writer.path} (${events} events)`);
    }
  } catch (error) {
    failure = failure ?? error;
  }

  // Only clear the id if no new recording took over during the await.
  if (recordingId === endingId && !session) {
    recordingId = null;
  }

  if (failure !== null) throw failure;
  return { recordingId: endingId, events, durationMs, reason };
}

// Graceful shutdown: only process signals end the process.
async function shutdown(reason: string): Promise<void> {
  let code = 0;
  try {
    await stopRecording(reason);
  } catch (error) {
    console.error("Shutdown cleanup failed:", error);
    code = 1;
  } finally {
    process.exit(code);
  }
}
process.on("SIGTERM", () => void shutdown("sigterm"));
process.on("SIGINT", () => void shutdown("sigint"));

// Start server
httpServer.listen(PORT, () => {
  console.log(`Recorder server listening on port ${PORT}`);
});
