/**
 * Proxy for orchestrator runs endpoint.
 * The browser cannot access the orchestrator directly in Docker.
 */

import { NextRequest } from "next/server";
import { requireUser } from "../../../../lib/auth/require-user";
import { checkExpectedSession, expectedSessionFailure } from "../../../../lib/auth/expected-session";
import { setRunOwner, clearRunOwner, type RunHistoryData } from "../../../../lib/editor/run-ownership";
import { resolveVariablesForRun } from "../../../../lib/variables/store";
import { prepareRunStart } from "./run-env";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
const SERVICE_TOKEN = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";

/**
 * Attempt to stop a run that was created but whose ownership could not be persisted.
 * Best-effort cleanup; errors are logged but not propagated.
 */
async function rollbackRun(runId: string): Promise<void> {
  try {
    await fetch(`${ORCHESTRATOR_URL}/api/runs/${runId}/stop`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SERVICE_TOKEN}` },
    });
  } catch {
    // Best-effort cleanup; run may already be stopped or unreachable
  }
}

export async function POST(request: NextRequest) {
  let user = await requireUser(request.headers.get("cookie"));
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Diagnostic starts must come from the session the client expects; load
    // starts keep the cookie-only check. Reuses the parsed body (single read).
    if (body?.mode === "diagnostic") {
      const session = await checkExpectedSession(request);
      if (!session.ok) return expectedSessionFailure(session.status);
      user = session.identity.user;
    }

    // Proxy-only fields (history + variables) are stripped before forwarding
    // (orchestrator rejects unknown fields). Secret env values are resolved
    // here from the database for the requested `requiredEnv` names only; a
    // client-sent `env` is always discarded. Never log the prepared body.
    const prepared = await prepareRunStart(body, user, resolveVariablesForRun);
    if (!prepared.ok) {
      return Response.json(
        prepared.errors ? { error: prepared.error, errors: prepared.errors } : { error: prepared.error },
        { status: prepared.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    const orchestratorBody = prepared.orchestratorBody;

    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
      },
      body: JSON.stringify(orchestratorBody),
    });

    const data = await res.text();

    // Track run ownership if creation succeeded
    if (res.ok) {
      let runId: string | undefined;
      try {
        const runData = JSON.parse(data);
        runId = runData.runId;
      } catch {
        // Could not parse run ID - run exists but we can't track it
        return Response.json(
          { error: "Run created but response unparseable; cannot track ownership" },
          { status: 502 }
        );
      }

      if (runId) {
        try {
          // Extract history data from the request body
          const historyData: RunHistoryData = {
            scenarioId: body.scenarioId,
            scenarioName: body.scenarioName,
            vus: body.vus,
            durationMs: body.durationMs,
          };
          await setRunOwner(runId, user.id, historyData);
        } catch (ownershipErr) {
          // Ownership persistence failed; rollback the run to prevent orphaned runs
          await rollbackRun(runId);
          await clearRunOwner(runId).catch(() => {}); // Best-effort cleanup
          return Response.json(
            { error: "Failed to persist run ownership; run was rolled back" },
            { status: 503 }
          );
        }
      }
    }

    return new Response(data, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Proxy error" },
      { status: 502 }
    );
  }
}
