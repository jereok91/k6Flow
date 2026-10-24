/**
 * POST /api/recorder/stop — stop the recording and persist its capture.
 *
 * The recorder owns the session; this route owns the library entry. It stops
 * through the recorder, reads the finished capture back and stores it in
 * `recordings`, so the review screen and the recordings list work off the
 * database instead of a file inside the recorder container.
 *
 * A stop the recorder refuses is relayed as-is: the UI must never be told a
 * recording ended when it did not.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { recordings } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { defaultRecordingName, summarizeCapture } from "../../../../lib/recorder/capture-summary";

const RECORDER_URL = process.env.RECORDER_UPSTREAM || "http://localhost:8081";

interface StopBody {
  recordingId?: unknown;
  name?: unknown;
  startUrl?: unknown;
  viewport?: { width?: unknown; height?: unknown };
}

interface RecorderStopAnswer {
  status?: string;
  recordingId?: string | null;
  events?: number;
  durationMs?: number;
  reason?: string;
}

function recorderToken(request: Request): string {
  // The server-side token wins; the client header keeps local setups working.
  if (process.env.RECORDER_AUTH_TOKEN) return process.env.RECORDER_AUTH_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "dev-token";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function intField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

interface SavedRecording {
  id: string;
  name: string;
  startUrl: string;
  requestCount: number;
  stepCount: number;
  durationMs: number;
  captureBytes?: number;
  scenarioId: string | null;
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  const body = (await request.json().catch(() => ({}))) as StopBody;
  const requestedId = stringField(body.recordingId);
  const token = recorderToken(request);

  let stopAnswer: RecorderStopAnswer;
  let stopStatus: number;
  try {
    const stopRes = await fetch(`${RECORDER_URL}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(requestedId ? { recordingId: requestedId } : {}),
    });
    stopStatus = stopRes.status;
    const text = await stopRes.text();
    if (!stopRes.ok) {
      // 401/409/500 from the recorder are the user's answer, not ours to reinterpret.
      return new Response(text || JSON.stringify({ error: "Failed to stop recording" }), {
        status: stopStatus,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    stopAnswer = JSON.parse(text || "{}") as RecorderStopAnswer;
  } catch (error) {
    console.error("Recorder stop proxy error:", error);
    return jsonError(502, "Failed to connect to recorder service");
  }

  const recordingId = stopAnswer.recordingId ?? requestedId ?? null;
  const status = stopAnswer.status ?? (recordingId === null ? "idle" : "stopped");
  if (recordingId === null) {
    return Response.json({ status, recordingId: null, persisted: false, recording: null }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  let db;
  try {
    db = getDb();
  } catch (error) {
    console.error("Recording persistence unavailable:", error);
    return Response.json(
      { status, recordingId, persisted: false, recording: null, warning: "Recording store unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [existing] = await db
      .select({
        id: recordings.id,
        ownerId: recordings.ownerId,
        name: recordings.name,
        startUrl: recordings.startUrl,
        state: recordings.state,
        durationMs: recordings.durationMs,
        requestCount: recordings.requestCount,
        stepCount: recordings.stepCount,
        scenarioId: recordings.scenarioId,
      })
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1);

    if (existing && existing.ownerId !== user.id && user.role !== "admin") {
      return jsonError(409, "Recording belongs to another user");
    }

    const captureRes = await fetch(`${RECORDER_URL}/captures/${encodeURIComponent(recordingId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    const capture = captureRes?.ok ? await captureRes.text() : null;

    if (capture === null) {
      // The capture is gone (recorder restarted, already collected). If this
      // recording was persisted before, answer with that instead of failing a
      // retry the user already completed.
      if (existing) {
        return Response.json(
          {
            status,
            recordingId,
            persisted: true,
            recording: {
              id: existing.id,
              name: existing.name,
              startUrl: existing.startUrl,
              requestCount: existing.requestCount ?? 0,
              stepCount: existing.stepCount ?? 0,
              durationMs: existing.durationMs ?? 0,
              scenarioId: existing.scenarioId,
            } satisfies SavedRecording,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { status, recordingId, persisted: false, recording: null, warning: "Capture unavailable" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const summary = summarizeCapture(capture);
    const startUrl = stringField(body.startUrl) ?? summary.startUrl ?? "";
    const name = defaultRecordingName(stringField(body.name) ?? existing?.name, startUrl);
    const durationMs = stopAnswer.durationMs && stopAnswer.durationMs > 0
      ? stopAnswer.durationMs
      : summary.durationMs;

    const saved: SavedRecording = {
      id: recordingId,
      name,
      startUrl,
      requestCount: summary.requestCount,
      stepCount: summary.stepCount,
      durationMs,
      captureBytes: summary.bytes,
      scenarioId: existing?.scenarioId ?? null,
    };

    await db
      .insert(recordings)
      .values({
        id: recordingId,
        ownerId: existing?.ownerId ?? user.id,
        name,
        startUrl,
        state: "completed",
        viewportWidth: intField(body.viewport?.width, 1280),
        viewportHeight: intField(body.viewport?.height, 720),
        durationMs,
        requestCount: summary.requestCount,
        stepCount: summary.stepCount,
        captureData: capture,
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: recordings.id,
        set: {
          name,
          startUrl,
          state: "completed",
          durationMs,
          requestCount: summary.requestCount,
          stepCount: summary.stepCount,
          captureData: capture,
          completedAt: new Date(),
        },
      });

    return Response.json(
      { status, recordingId, persisted: true, recording: saved },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to persist recording:", error);
    return Response.json(
      { status, recordingId, persisted: false, recording: null, warning: "Failed to save recording" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
