/**
 * POST /api/recorder/stop — stop a recording and persist its capture.
 *
 * The recorder owns the browser session; this route owns the library entry. It
 * proves the caller owns the recording *before* touching the recorder (one
 * session is shared by the whole instance), stops it, reads the finished capture
 * back and stores it in `recordings`.
 *
 * A stop the recorder refuses is relayed as-is: the UI must never be told a
 * recording ended when it did not.
 */

import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { recordings } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { defaultRecordingName, summarizeCapture } from "../../../../lib/recorder/capture-summary";
import { intField, stringField } from "../../../../lib/recorder/fields";
import { recorderBaseUrl, recorderToken } from "../../../../lib/recorder/upstream";

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

interface RecordingRow {
  id: string;
  ownerId: string;
  name: string;
  startUrl: string;
  state: string;
  durationMs: number | null;
  requestCount: number | null;
  stepCount: number | null;
  scenarioId: string | null;
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

const RECORDING_COLUMNS = {
  id: recordings.id,
  ownerId: recordings.ownerId,
  name: recordings.name,
  startUrl: recordings.startUrl,
  state: recordings.state,
  durationMs: recordings.durationMs,
  requestCount: recordings.requestCount,
  stepCount: recordings.stepCount,
  scenarioId: recordings.scenarioId,
};

function toSavedRecording(row: RecordingRow): SavedRecording {
  return {
    id: row.id,
    name: row.name,
    startUrl: row.startUrl,
    requestCount: row.requestCount ?? 0,
    stepCount: row.stepCount ?? 0,
    durationMs: row.durationMs ?? 0,
    scenarioId: row.scenarioId,
  };
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Largest capture this tier will read and store, so one page cannot OOM it. */
const MAX_CAPTURE_BYTES = (() => {
  const configured = Number.parseInt(process.env.RECORDER_MAX_CAPTURE_BYTES ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 32 * 1024 * 1024;
})();

/** Drop the recorder-side capture once the library holds it. Idempotent. */
function releaseCapture(recordingId: string, token: string): void {
  void fetch(`${recorderBaseUrl()}/captures/${encodeURIComponent(recordingId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  const body = (await request.json().catch(() => ({}))) as StopBody;
  const recordingId = stringField(body.recordingId);
  if (recordingId === undefined) {
    // Without an id there is no way to prove ownership, and the recorder would
    // stop whichever session happens to be live.
    return jsonError(400, "Missing recording id");
  }
  const token = recorderToken(request);

  let db;
  try {
    db = getDb();
  } catch (error) {
    console.error("Recording store unavailable:", error);
    return jsonError(503, "Recording store unavailable");
  }

  let existing: RecordingRow;
  try {
    const [row] = await db
      .select(RECORDING_COLUMNS)
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1);
    if (!row) {
      return jsonError(404, "Recording not found");
    }
    // Ownership is decided here, before the stop request reaches the recorder. A
    // foreign recording answers 404 so ids cannot be enumerated.
    if (row.ownerId !== user.id && user.role !== "admin") {
      return jsonError(404, "Recording not found");
    }
    // A recording already saved is idempotent: answer the stored numbers instead
    // of recomputing them from a second source. A retry is also the last chance to
    // release a capture whose earlier delete failed.
    if (row.state === "completed") {
      releaseCapture(recordingId, token);
      return Response.json(
        { status: "idle", recordingId, persisted: true, recording: toSavedRecording(row) },
        { headers: NO_STORE },
      );
    }
    existing = row;
  } catch (error) {
    console.error("Failed to read recording:", error);
    return jsonError(500, "Internal server error");
  }

  let stopAnswer: RecorderStopAnswer;
  // A refused stop is only forgiven once the capture proves the recording is over.
  let rejection: { status: number } | null = null;
  try {
    const stopRes = await fetch(`${recorderBaseUrl()}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recordingId }),
    });
    const text = await stopRes.text();
    if (stopRes.status === 409) {
      // The recorder stopped nothing: this recording is not the live session, so it
      // ended on its own (inactivity or max duration). Whether its capture is final
      // is decided below, from the capture itself, never from this rejection.
      // The recorder's body names whichever session is live; never relay it.
      rejection = { status: 409 };
      stopAnswer = { status: "ended", recordingId, durationMs: 0 };
    } else if (!stopRes.ok) {
      return new Response(text || JSON.stringify({ error: "Failed to stop recording" }), {
        status: stopRes.status,
        headers: { "Content-Type": "application/json", ...NO_STORE },
      });
    } else {
      stopAnswer = JSON.parse(text || "{}") as RecorderStopAnswer;
    }
  } catch (error) {
    console.error("Recorder stop proxy error:", error);
    return jsonError(502, "Failed to connect to recorder service");
  }

  const status = stopAnswer.status ?? "stopped";

  try {
    const captureRes = await fetch(
      `${recorderBaseUrl()}/captures/${encodeURIComponent(recordingId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => null);
    const oversized = Number(captureRes?.headers.get("content-length") ?? "0") > MAX_CAPTURE_BYTES;
    const capture = captureRes?.ok && !oversized ? await captureRes.text() : null;

    if (capture === null) {
      if (rejection !== null) {
        // No capture and a refused stop: relay the rejection so the UI can keep the
        // session and retry instead of believing it finished.
        return jsonError(rejection.status, "Failed to stop recording");
      }
      if (oversized) {
        return Response.json(
          { status, recordingId, persisted: false, recording: null, warning: "Capture too large" },
          { headers: NO_STORE },
        );
      }
      // A concurrent retry may have won the race and deleted the file after saving
      // it: answer with the stored row instead of claiming nothing was saved.
      const [saved] = await db
        .select(RECORDING_COLUMNS)
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
      if (saved?.state === "completed") {
        return Response.json(
          { status, recordingId, persisted: true, recording: toSavedRecording(saved) },
          { headers: NO_STORE },
        );
      }
      return Response.json(
        { status, recordingId, persisted: false, recording: null, warning: "Capture unavailable" },
        { headers: NO_STORE },
      );
    }

    const summary = summarizeCapture(capture);

    // A readable file without its end marker is a partial capture: a crash or a
    // failed flush. Storing it as completed would hide the loss and hand the
    // review screen a truncated recording.
    if (!summary.complete) {
      if (rejection !== null) {
        return jsonError(rejection.status, "Failed to stop recording");
      }
      return Response.json(
        { status, recordingId, persisted: false, recording: null, warning: "Capture incomplete" },
        { headers: NO_STORE },
      );
    }

    const startUrl = stringField(body.startUrl) || existing.startUrl || summary.startUrl || "";
    const name = defaultRecordingName(
      stringField(body.name) || existing.name,
      startUrl,
      summary.startedAt,
    );
    const durationMs = stopAnswer.durationMs && stopAnswer.durationMs > 0
      ? stopAnswer.durationMs
      : summary.durationMs;

    const stored = {
      name,
      startUrl,
      state: "completed",
      durationMs,
      requestCount: summary.requestCount,
      stepCount: summary.stepCount,
      captureData: capture,
      completedAt: new Date(),
    };

    await db
      .insert(recordings)
      .values({
        id: recordingId,
        ownerId: existing.ownerId,
        viewportWidth: intField(body.viewport?.width, 1280),
        viewportHeight: intField(body.viewport?.height, 720),
        ...stored,
      })
      // First stop wins: a concurrent retry must not overwrite the terminal row
      // the other request just wrote.
      .onConflictDoUpdate({
        target: recordings.id,
        set: stored,
        setWhere: ne(recordings.state, "completed"),
      });

    const [after] = await db
      .select(RECORDING_COLUMNS)
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1);

    const saved = after ? toSavedRecording(after) : toSavedRecording({ ...existing, ...stored });

    // The library holds the capture now; dropping the recorder-side file keeps
    // the capture volume bounded.
    releaseCapture(recordingId, token);

    return Response.json(
      { status, recordingId, persisted: true, recording: { ...saved, captureBytes: summary.bytes } },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("Failed to persist recording:", error);
    // The capture is still on the recorder: a 5xx keeps the page retryable instead
    // of telling the user the stop finished with nothing saved.
    return jsonError(503, "Failed to save recording");
  }
}
