// POST /api/endpoint-tests: run exactly one allow-listed endpoint test.
//
// The route is only the boundary: it authenticates, binds the request to the
// session the client expects, strictly parses a bounded body, resolves the
// caller's variables server-side, and hands the prepared request to the
// injected executor. The allow-list (ENDPOINT_TEST_ALLOWED_TARGETS) stays the
// only authority on reachable targets and the executor performs that check
// before it ever resolves a name. Nothing here logs, echoes a submitted value,
// a resolved variable or upstream text, and every response is no-store.
import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { requireUser } from "../../../lib/auth/require-user";
import { checkExpectedSession, expectedSessionFailure } from "../../../lib/auth/expected-session";
import { resolveVariablesForRun, storeFailureResponse } from "../../../lib/variables/store";
import { prepareEndpointTest } from "../../../lib/endpoint-test/prepare";
import {
  executeEndpointTest,
  type EndpointIo,
  type EndpointTestResult,
} from "../../../lib/endpoint-test/execute";
import { createNodeTransport } from "../../../lib/endpoint-test/transport";

export const runtime = "nodejs";

/** Hard cap on the incoming request body: 64 KiB, read before any parsing. */
const ENDPOINT_TEST_REQUEST_LIMIT = 65_536;

/** The only keys a request body may carry; anything else is rejected whole. */
const BODY_KEYS = new Set(["parameters", "samples", "scenarioId", "environmentId"]);

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface EndpointTestRouteBody {
  readonly parameters: unknown;
  readonly samples: Readonly<Record<string, string>>;
  readonly scenarioId: string | null;
  readonly environmentId: string | null;
}

/**
 * Fixed statuses per executor result kind. `denied` is a policy refusal (not a
 * client error), `invalid-input` is the client's request, and the two transport
 * outcomes are distinguished so the client can tell a timeout from a refusal.
 */
const RESULT_STATUS: Readonly<Record<EndpointTestResult["kind"], number>> = {
  ok: 200,
  denied: 403,
  timeout: 504,
  network: 502,
  "invalid-input": 400,
};

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireUser(request.headers.get("cookie"));
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  // Bind to the expected session before touching the body; a mismatched or
  // unavailable session is answered exactly as U0 does.
  const session = await checkExpectedSession(request);
  if (!session.ok) return expectedSessionFailure(session.status);

  const raw = await readBoundedText(request);
  if (raw === null) {
    return Response.json({ error: "Request body too large" }, { status: 400, headers: NO_STORE });
  }

  const body = parseBody(raw);
  if (!body) {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const resolved = await resolveVariablesForRun(user, body.scenarioId, body.environmentId);
  if (!resolved.ok) {
    // Reuse the repository's store-failure convention (403/404/409/422) instead
    // of inventing a parallel mapping: its fixed bodies never echo the ids, and
    // collapsing a real 403 into a 400 would misreport an ownership denial.
    return storeFailureResponse(resolved, "Variables");
  }

  const variables: Record<string, string> = {};
  const secretNames: string[] = [];
  for (const variable of resolved.value) {
    variables[variable.name] = variable.value;
    if (variable.secret) secretNames.push(variable.name);
  }

  const prepared = prepareEndpointTest(body.parameters, {
    variables,
    secretNames,
    samples: body.samples,
  });
  if (!prepared.ok) {
    return Response.json(
      { error: "Invalid endpoint request", reason: prepared.reason },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await executeEndpointTest(
    {
      url: prepared.input.url,
      method: prepared.input.method,
      headers: prepared.input.headers,
      ...(prepared.input.bodyText === undefined ? {} : { bodyText: prepared.input.bodyText }),
      allowList: process.env.ENDPOINT_TEST_ALLOWED_TARGETS,
      secretValues: prepared.input.secretValues,
    },
    buildIo(),
  );
  return resultResponse(result);
}

/** JSON response helper: every outcome is no-store and never cacheable. */
function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function resultResponse(result: EndpointTestResult): Response {
  switch (result.kind) {
    case "ok":
      return json(RESULT_STATUS.ok, {
        kind: "ok",
        status: result.status,
        timingMs: result.timingMs,
        headers: result.headers,
        bodyText: result.bodyText,
        truncated: result.truncated,
      });
    case "denied":
      return json(RESULT_STATUS.denied, { kind: "denied", reason: result.reason });
    case "timeout":
      return json(RESULT_STATUS.timeout, { error: "Endpoint timed out" });
    case "network":
      return json(RESULT_STATUS.network, { error: "Endpoint unreachable" });
    case "invalid-input":
      return json(RESULT_STATUS["invalid-input"], { error: "Invalid endpoint request", reason: result.reason });
  }
}

/**
 * Real IO for the executor: DNS is resolved once through node and the merged
 * address list is handed back so the executor can pin the connection. Nothing
 * is resolved here, before the executor's static allow-list pass.
 */
function buildIo(): EndpointIo {
  return {
    resolve: async host => {
      const records = await lookup(host, { all: true });
      return records.map(record => record.address);
    },
    transport: createNodeTransport(),
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Strict parse of the bounded body. Any unknown key, wrong type or non-object
 * payload is rejected; submitted values are never surfaced.
 */
function parseBody(raw: string): EndpointTestRouteBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BODY_KEYS.has(key)) return null;
  }
  if (!("parameters" in record)) return null;

  const samples = readSamples(record.samples);
  if (!samples) return null;
  const scenarioId = readOptionalId(record.scenarioId);
  const environmentId = readOptionalId(record.environmentId);
  if (!scenarioId.ok || !environmentId.ok) return null;

  return {
    parameters: record.parameters,
    samples,
    scenarioId: scenarioId.value,
    environmentId: environmentId.value,
  };
}

function readSamples(value: unknown): Readonly<Record<string, string>> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const samples: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    samples[key] = entry;
  }
  return samples;
}

function readOptionalId(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false };
}

/**
 * Reads the body up to the cap. A larger declared or actual body returns null
 * without reading it whole, so an oversized request cannot force unbounded work.
 */
async function readBoundedText(request: NextRequest): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > ENDPOINT_TEST_REQUEST_LIMIT) return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > ENDPOINT_TEST_REQUEST_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
