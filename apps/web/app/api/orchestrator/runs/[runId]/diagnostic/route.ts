import { NextRequest } from "next/server";
import { diagnosticEventSchema, diagnosticMetadataSchema } from "@k6flow/shared";
import { checkExpectedSession, expectedSessionFailure } from "../../../../../../lib/auth/expected-session";
import { getRunOwner, isRunOwner } from "../../../../../../lib/editor/run-ownership";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";
const headers = { "Cache-Control": "no-store" };
const error = (status: number, message: string) => Response.json({ error: message }, { status, headers });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// A bounded read prevents even a broken upstream from retaining unbounded data.
async function readSnapshot(response: Response, runId: string) {
  if (!response.body) throw new Error("Invalid snapshot");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128 * 1024) throw new Error("Invalid snapshot");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || !exactKeys(data, ["version", "runId", "status", "diagnostic", "trace"]) || data.version !== 1 || data.runId !== runId ||
      typeof data.status !== "string" || !["pending", "running", "finished", "failed", "stopped", "queued", "starting", "stopping", "aborted", "errored"].includes(data.status) ||
      !isObject(data.trace) || !exactKeys(data.trace, ["state", "events"]) || typeof data.trace.state !== "string" ||
      !["pending", "running", "complete", "failed", "incomplete", "interrupted"].includes(data.trace.state) || !Array.isArray(data.trace.events) || data.trace.events.length > 201) throw new Error("Invalid snapshot");
  const diagnostic = diagnosticMetadataSchema.parse(data.diagnostic);
  const events = data.trace.events.map(event => diagnosticEventSchema.parse(event));
  return { version: 1, runId, status: data.status, diagnostic, trace: { state: data.trace.state, events } };
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
        const response = await fetch(`${ORCHESTRATOR_URL}/api/runs/${encodeURIComponent(runId)}/diagnostic`, {
          headers: { Authorization: `Bearer ${SERVICE_TOKEN}` }, cache: "no-store", signal: controller.signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return error(response.status === 404 ? 404 : response.status === 409 ? 409 : 502, "Diagnostic unavailable");
        }
        const snapshot = await readSnapshot(response, runId);
        // Narrow the TOCTOU window: never hand a snapshot to a session that changed mid-read.
        const recheck = await checkExpectedSession(request);
        if (!recheck.ok) return expectedSessionFailure(recheck.status);
        return Response.json(snapshot, { headers });
      };
      return await Promise.race([upstream(), timeout]);
    } catch {
      return error(timedOut ? 504 : 502, "Diagnostic unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  } catch {
    return error(502, "Diagnostic unavailable");
  }
}
