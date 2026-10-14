// Client adapter for POST /api/endpoint-tests. It binds every request to the
// live session marker, bounds every response read and maps the route's fixed
// statuses to a discriminated union with fixed Spanish messages. Server text is
// never surfaced, nothing is logged and nothing is persisted.

import {
  isSessionMarker,
  withSessionMarker,
  type MarkerFetch,
} from "../auth/session-marker-header";
import type { EndpointTestResult } from "../endpoint-test/execute";

export const ENDPOINT_TEST_PATH = "/api/endpoint-tests";
/** Mirrors the server's 64 KiB body cap so a hostile response cannot grow a result. */
export const ENDPOINT_TEST_BODY_LIMIT = 65_536;
/** Hard cap on the JSON envelope read from the route. */
const ENDPOINT_TEST_RESPONSE_LIMIT = 131_072;

/**
 * Client-side bound on one test request. The route bounds its own executor at 5 s (DNS
 * resolution, connect and body) while the DB-backed variable resolution and the session
 * check run before it, so the client waits longer than the executor and still ends a
 * request that never settles.
 */
export const ENDPOINT_TEST_CLIENT_TIMEOUT_MS = 10_000;

/** The success payload of execute.ts, minus the discriminant we hold outside it. */
export type EndpointTestOkResult = Omit<
  Extract<EndpointTestResult, { readonly kind: "ok" }>,
  "kind"
>;

export type EndpointTestClientResult =
  | { readonly kind: "ok"; readonly result: EndpointTestOkResult }
  | { readonly kind: "denied"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "session-changed"; readonly message: string };

type FailureKind = Exclude<EndpointTestClientResult["kind"], "ok">;

/** Fixed Spanish messages. Server text is deliberately never used here. */
export const ENDPOINT_TEST_MESSAGES: Readonly<Record<FailureKind, string>> = Object.freeze({
  denied: "Destino no autorizado",
  timeout: "El destino agotó el tiempo de espera",
  network: "No se pudo contactar con el destino",
  invalid: "Solicitud o respuesta no válida",
  unavailable: "No se pudo preparar la prueba con esos datos",
  "session-changed": "La sesión cambió · vuelve a verificar",
});

export interface EndpointTestClientInput {
  readonly parameters: unknown;
  readonly samples?: Readonly<Record<string, string>>;
  readonly scenarioId?: string;
  readonly environmentId?: string;
}

export interface EndpointTestClientIo {
  /** Injected transport; defaults to the global fetch. */
  readonly fetch?: MarkerFetch;
  /** Live session marker; a non-marker value is refused before any request. */
  readonly sessionMarker: string;
  /** Test-only override of the whole-operation deadline; defaults to ENDPOINT_TEST_CLIENT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

const OK_FIELDS = new Set(["kind", "status", "timingMs", "headers", "bodyText", "truncated"]);

export async function runEndpointTest(
  input: EndpointTestClientInput,
  io: EndpointTestClientIo,
): Promise<EndpointTestClientResult> {
  // Never issue a request without a well-formed marker: the route would only
  // answer 412, and the caller should re-verify the session instead.
  if (!isSessionMarker(io.sessionMarker)) return failure("session-changed");
  const marker = withSessionMarker(
    io.fetch ?? ((url, init) => fetch(url, init)),
    io.sessionMarker,
  );

  const body: Record<string, unknown> = { parameters: input.parameters };
  if (input.samples !== undefined) body.samples = input.samples;
  if (input.scenarioId !== undefined) body.scenarioId = input.scenarioId;
  if (input.environmentId !== undefined) body.environmentId = input.environmentId;

  // The editor releases its single-flight latch in this same finally, and the route
  // bounds only its own executor, so the client deadline must bound the WHOLE
  // operation: transport, status handling and every body read or discard. A response
  // whose headers arrive but whose body never produces data would otherwise leave the
  // button disabled until a reload.
  const controller = new AbortController();
  // What the deadline reports if it wins; each phase sets the outcome it stands for.
  let onDeadline: FailureKind = "timeout";
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<EndpointTestClientResult>(resolve => {
    timer = setTimeout(() => {
      // Aborting cancels a locked body through readBoundedJson's listener; an unlocked
      // body is cancelled here so an unterminated stream is not left attached.
      controller.abort();
      if (response) void discard(response);
      resolve(failure(onDeadline));
    }, io.timeoutMs ?? ENDPOINT_TEST_CLIENT_TIMEOUT_MS);
  });

  const exchange = async (): Promise<EndpointTestClientResult> => {
    try {
      response = await marker(ENDPOINT_TEST_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // A rejected transport is indistinguishable from an unreachable target, but our own
      // deadline is a timeout, and that is the outcome the caller can act on.
      return failure(controller.signal.aborted ? "timeout" : "network");
    }
    // Headers that arrive after the deadline already lost; release their body.
    if (controller.signal.aborted) {
      void discard(response);
      return failure("timeout");
    }
    return handleStatus(response, controller.signal, kind => {
      onDeadline = kind;
    });
  };

  try {
    return await Promise.race([exchange(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps the route's status to a fixed outcome. Before any body work, `decide` records
 * what the deadline should report if that body work never finishes: the outcome a
 * discard branch already fixed, or the outcome an unreadable body maps to.
 */
async function handleStatus(
  response: Response,
  signal: AbortSignal,
  decide: (kind: FailureKind) => void,
): Promise<EndpointTestClientResult> {
  const settle = async (kind: FailureKind): Promise<EndpointTestClientResult> => {
    decide(kind);
    await discard(response);
    return failure(kind);
  };
  switch (response.status) {
    case 200: {
      // A stalled success body is the target not answering in time.
      decide("timeout");
      const payload = await readBoundedJson(response, signal);
      const parsed = payload === null ? null : parseOkPayload(payload);
      return parsed ? { kind: "ok", result: parsed } : failure("invalid");
    }
    case 401:
    case 412:
      return settle("session-changed");
    case 403: {
      // The route answers 403 twice: for a destination the allow-list blocks, with
      // kind "denied", and for a variables-store ownership denial, which follows the
      // store's {error} convention. Only the first is a blocked destination, and
      // blaming the target for a permission failure misreports the cause. A body that
      // never arrives proves nothing, so it maps like any unreadable 403 body.
      decide("unavailable");
      const payload = await readBoundedJson(response, signal);
      const blocked =
        typeof payload === "object" && payload !== null &&
        (payload as { readonly kind?: unknown }).kind === "denied";
      return failure(blocked ? "denied" : "unavailable");
    }
    case 504:
      return settle("timeout");
    case 502:
      return settle("network");
    case 400:
      return settle("invalid");
    case 404:
    case 409:
    case 422:
    case 503:
      // The request shape was fine; the route could not prepare the test (a
      // missing environment, for example), so "invalid request" would misreport it.
      return settle("unavailable");
    default:
      // Any other status is unexpected; the caller learns nothing from its body.
      return settle("invalid");
  }
}

function failure(kind: FailureKind): EndpointTestClientResult {
  return { kind, message: ENDPOINT_TEST_MESSAGES[kind] };
}

/** Releases an unread body without decoding it; the outcome is already fixed. */
async function discard(response: Response): Promise<void> {
  try {
    // A body locked by a reader is cancelled through that reader instead.
    if (response.body && !response.body.locked) await response.body.cancel();
  } catch {
    /* Best effort only. */
  }
}

/**
 * Reads the whole envelope up to a hard cap, then parses it. A body that would
 * exceed the cap, an unreadable stream and malformed JSON all answer null.
 */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  // When the deadline aborts, cancel the stream so a pending read settles and the
  // unterminated body is released rather than left attached.
  const cancel = () => {
    reader.cancel().catch(() => {
      /* Best effort only. */
    });
  };
  if (signal.aborted) {
    cancel();
    reader.releaseLock();
    return null;
  }
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > ENDPOINT_TEST_RESPONSE_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (signal.aborted) return null;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    return null;
  }
}

/**
 * Strict success parser: an unknown or missing field, a wrong type or a
 * malformed header entry makes the whole payload invalid rather than partially
 * trusted. Headers and body are copied and bounded, never returned by reference.
 */
function parseOkPayload(value: unknown): EndpointTestOkResult | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "ok") return null;
  for (const key of Object.keys(value)) {
    if (!OK_FIELDS.has(key)) return null;
  }
  const { status, timingMs, headers, bodyText, truncated } = value;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) return null;
  if (typeof timingMs !== "number" || !Number.isFinite(timingMs) || timingMs < 0) return null;
  if (typeof bodyText !== "string") return null;
  if (typeof truncated !== "boolean") return null;
  const parsedHeaders = parseHeaders(headers);
  if (!parsedHeaders) return null;
  const bounded = bodyText.slice(0, ENDPOINT_TEST_BODY_LIMIT);
  return {
    status,
    timingMs,
    headers: parsedHeaders,
    bodyText: bounded,
    truncated: truncated || bounded.length !== bodyText.length,
  };
}

function parseHeaders(value: unknown): readonly { readonly name: string; readonly value: string }[] | null {
  if (!Array.isArray(value)) return null;
  const headers: { name: string; value: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("name") || !keys.includes("value")) return null;
    if (typeof entry.name !== "string" || typeof entry.value !== "string") return null;
    headers.push({ name: entry.name, value: entry.value });
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface EndpointTestLastResults {
  get(nodeId: string): EndpointTestClientResult | undefined;
  set(nodeId: string, result: EndpointTestClientResult): void;
  /** Clears one node, or every node when called with no argument. */
  clear(nodeId?: string): void;
}

/**
 * Memory-only last result per node. No persistence and no window access at
 * import time; the page calls clear() on session invalidation and node removal.
 */
export function createEndpointTestLastResults(): EndpointTestLastResults {
  const results = new Map<string, EndpointTestClientResult>();
  return {
    get: nodeId => results.get(nodeId),
    set: (nodeId, result) => {
      results.set(nodeId, result);
    },
    clear: nodeId => {
      if (nodeId === undefined) results.clear();
      else results.delete(nodeId);
    },
  };
}
