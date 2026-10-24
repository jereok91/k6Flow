/**
 * POST /api/recorder/start — start a recording and reserve its library entry.
 *
 * The recorder owns the browser session; this route owns the claim. Reserving
 * the recording here, with the caller as its owner, is what makes the stop
 * authorization possible: only the user who started a recording can stop it and
 * collect its capture.
 */

import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../../lib/db/client";
import { recordings } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { defaultRecordingName } from "../../../../lib/recorder/capture-summary";
import { intField, stringField } from "../../../../lib/recorder/fields";
import { recorderBaseUrl, recorderToken } from "../../../../lib/recorder/upstream";

/** Best-effort cleanup of a session this route just created and cannot reserve. */
function abandonSession(recordingId: string, token: string): void {
  void fetch(`${recorderBaseUrl()}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recordingId }),
  }).catch(() => undefined);
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  const rawBody = await request.text();
  const body = (() => {
    try {
      return JSON.parse(rawBody || "{}") as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const token = recorderToken(request);

  let answer: Record<string, unknown>;
  try {
    const res = await fetch(`${recorderBaseUrl()}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: rawBody || "{}",
    });
    const text = await res.text();
    if (!res.ok) {
      // 401/409/500 from the recorder are the caller's answer, not ours.
      return new Response(text || JSON.stringify({ error: "Failed to start recording" }), {
        status: res.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    answer = JSON.parse(text || "{}") as Record<string, unknown>;
  } catch (error) {
    console.error("Recorder start proxy error:", error);
    return jsonError(502, "Failed to connect to recorder service");
  }

  const recordingId = stringField(answer.recordingId);
  if (recordingId === undefined) {
    return jsonError(502, "Recorder did not return a recording id");
  }

  const startUrl = stringField(body.startUrl) ?? "";
  const name = defaultRecordingName(stringField(body.name), startUrl);
  // A reconnect answer means the recorder handed back a session that already
  // exists: it is not ours to abandon.
  const createdSession = answer.status !== "reconnected";

  try {
    const db = getDb();
    const [existing] = await db
      .select({ ownerId: recordings.ownerId })
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1);

    // Reconnecting to the live session is allowed for its owner only: a second
    // user must not adopt someone else's recording id, and this refusal must not
    // touch the session it failed to adopt — that browser is still recording for
    // its owner.
    if (existing && existing.ownerId !== user.id && user.role !== "admin") {
      return jsonError(409, "Recording belongs to another user");
    }

    await db
      .insert(recordings)
      .values({
        id: recordingId,
        ownerId: existing?.ownerId ?? user.id,
        name,
        startUrl,
        // Reserved while it runs; a stop turns it into `completed`.
        state: "recording",
        viewportWidth: intField(body.viewportWidth, 1280),
        viewportHeight: intField(body.viewportHeight, 720),
      })
      // A finished recording keeps its terminal state and its stored numbers.
      .onConflictDoUpdate({
        target: recordings.id,
        set: { name, startUrl, state: "recording" },
        setWhere: ne(recordings.state, "completed"),
      });
  } catch (error) {
    console.error("Failed to reserve recording:", error);
    if (createdSession) abandonSession(recordingId, token);
    return jsonError(503, "Recording store unavailable");
  }

  return Response.json(
    { ...answer, name },
    { headers: { "Cache-Control": "no-store" } },
  );
}
