import { NextRequest } from "next/server";
import { metricsFrameSchema } from "@k6flow/shared";
import { checkExpectedSession, expectedSessionFailure } from "../../../../../../lib/auth/expected-session";
import { getRunOwner, isRunOwner } from "../../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";
const headers = { "Cache-Control": "no-store" };
const error = (status: number, message: string) => Response.json({ error: message }, { status, headers });
// A metrics frame is a handful of numbers; this bound only protects the proxy
// from a broken upstream (a 1100-byte frame is already padded).
const MAX_FRAME_BYTES = 8 * 1024;

// The fallback frame is passed through, never reshaped: it is parsed with the
// shared metrics-frame contract so the browser receives exactly the shape the
// orchestrator sends (and the WS `tick` carries).
async function readFrame(response: Response, runId: string) {
  if (!response.body) throw new Error("Invalid metrics snapshot");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FRAME_BYTES) throw new Error("Invalid metrics snapshot");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const frame = metricsFrameSchema.parse(JSON.parse(text) as unknown);
  if (frame.runId !== runId) throw new Error("Invalid metrics snapshot");
  return frame;
}

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const session = await checkExpectedSession(request);
    if (!session.ok) return expectedSessionFailure(session.status);
    const { runId } = await context.params;
    if (!(await getRunOwner(runId)) || !(await isRunOwner(runId, session.identity.user.id))) return error(403, "Forbidden");

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("Timeout")); }, 5000);
    });
    try {
      const upstream = async () => {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/runs/${encodeURIComponent(runId)}/metrics`, {
          headers: { Authorization: `Bearer ${SERVICE_TOKEN}` }, cache: "no-store", signal: controller.signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return error(response.status === 404 ? 404 : 502, "Metrics unavailable");
        }
        const frame = await readFrame(response, runId);
        // Narrow the TOCTOU window: never hand a frame to a session that changed mid-read.
        const recheck = await checkExpectedSession(request);
        if (!recheck.ok) return expectedSessionFailure(recheck.status);
        return Response.json(frame, { headers });
      };
      return await Promise.race([upstream(), timeout]);
    } catch {
      return error(timedOut ? 504 : 502, "Metrics unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  } catch {
    return error(502, "Metrics unavailable");
  }
}
