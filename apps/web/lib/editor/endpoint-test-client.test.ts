import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_MARKER_HEADER,
  type MarkerFetch,
} from "../auth/session-marker-header";
import {
  createEndpointTestLastResults,
  runEndpointTest,
  type EndpointTestClientIo,
  ENDPOINT_TEST_CLIENT_TIMEOUT_MS,
} from "./endpoint-test-client";

const LIVE = "a".repeat(64);
const SERVER_TEXT = "SERVER_PRIVATE_TEXT";

// The fixed Spanish messages are part of the contract; the assertions restate
// them so a change in wording is a visible, intentional edit.
const EXPECTED_MESSAGES = {
  denied: "Destino no autorizado",
  timeout: "El destino agotó el tiempo de espera",
  network: "No se pudo contactar con el destino",
  invalid: "Solicitud o respuesta no válida",
  "session-changed": "La sesión cambió · vuelve a verificar",
} as const;

const OK_PAYLOAD = {
  kind: "ok",
  status: 200,
  timingMs: 12,
  headers: [{ name: "content-type", value: "application/json" }],
  bodyText: '{"ok":true}',
  truncated: false,
};

const STATUS_CASES: ReadonlyArray<[number, keyof typeof EXPECTED_MESSAGES]> = [
  [504, "timeout"],
  [502, "network"],
  [400, "invalid"],
  [401, "session-changed"],
  [412, "session-changed"],
];

function makeIo(fetcher: MarkerFetch, sessionMarker = LIVE): EndpointTestClientIo {
  return { fetch: fetcher, sessionMarker };
}

function okFetch() {
  return vi.fn().mockResolvedValue(Response.json(OK_PAYLOAD));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("posts the exact body with the session marker header", async () => {
  const fetcher = okFetch();
  const result = await runEndpointTest(
    {
      parameters: { method: "GET" },
      samples: { "n1:out": "sample" },
      scenarioId: "s1",
      environmentId: "e1",
    },
    makeIo(fetcher),
  );
  expect(result.kind).toBe("ok");
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("/api/endpoint-tests");
  expect(init.method).toBe("POST");
  const headers = new Headers(init.headers);
  expect(headers.get(SESSION_MARKER_HEADER)).toBe(LIVE);
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual({
    parameters: { method: "GET" },
    samples: { "n1:out": "sample" },
    scenarioId: "s1",
    environmentId: "e1",
  });
});

it("omits optional keys that were not provided", async () => {
  const fetcher = okFetch();
  await runEndpointTest({ parameters: { method: "GET" } }, makeIo(fetcher));
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    parameters: { method: "GET" },
  });
});

it.each(STATUS_CASES)("maps HTTP %i to %s without echoing the body", async (status, kind) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(SERVER_TEXT, { status }));
  const result = await runEndpointTest({ parameters: { method: "GET" } }, makeIo(fetcher));
  expect(result.kind).toBe(kind);
  if (result.kind === "ok") throw new Error("unexpected ok result");
  expect(result.message).toBe(EXPECTED_MESSAGES[kind]);
});

it.each([
  [404, "unavailable"],
  [409, "unavailable"],
  [422, "unavailable"],
  [503, "unavailable"],
  [418, "invalid"],
])("maps HTTP %i to %s, because the request shape itself was fine", async (status, kind) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(SERVER_TEXT, { status }));
  const result = await runEndpointTest({ parameters: { method: "GET" } }, makeIo(fetcher));
  expect(result.kind).toBe(kind);
  if (result.kind === "ok") throw new Error("unexpected ok result");
  expect(result.message.length).toBeGreaterThan(0);
  expect(result.message).not.toContain(SERVER_TEXT);
});

it("tells a variables-store 403 apart from a blocked destination", async () => {
  // The route answers 403 for a blocked destination (kind "denied") and for a
  // variables-store ownership denial, which follows the store's {error} convention:
  // reporting the second as a blocked destination blames the target for a permission.
  const store = vi.fn().mockResolvedValue(new Response('{"error":"Forbidden"}', { status: 403 }));
  expect((await runEndpointTest({ parameters: {} }, makeIo(store))).kind).toBe("unavailable");
  const blocked = vi.fn().mockResolvedValue(
    Response.json({ kind: "denied", reason: "host-not-allowed" }, { status: 403 }),
  );
  expect((await runEndpointTest({ parameters: {} }, makeIo(blocked))).kind).toBe("denied");
});

it("bounds a request that never settles instead of leaving the latch set", async () => {
  vi.useFakeTimers();
  try {
    // A transport that only ever ends when it is aborted: without a signal from the
    // client nothing bounds the await, and the editor releases its single-flight latch
    // in that same finally, so the button stays disabled until a page reload.
    const fetcher = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const bound = setTimeout(() => reject(new Error("never settled")), 2 * ENDPOINT_TEST_CLIENT_TIMEOUT_MS);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(bound);
          reject(new Error("aborted"));
        });
      }));
    const pending = runEndpointTest({ parameters: {} }, makeIo(fetcher));
    await vi.advanceTimersByTimeAsync(2 * ENDPOINT_TEST_CLIENT_TIMEOUT_MS);
    expect((await pending).kind).toBe("timeout");
  } finally {
    vi.useRealTimers();
  }
});

it("maps a rejected transport to network", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error(SERVER_TEXT));
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result).toEqual({ kind: "network", message: EXPECTED_MESSAGES.network });
});

it("maps an unparseable 200 body to invalid", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result).toEqual({ kind: "invalid", message: EXPECTED_MESSAGES.invalid });
});

it.each(["kind", "status", "timingMs", "headers", "bodyText", "truncated"])(
  "maps an ok payload missing %s to invalid",
  async field => {
    const payload: Record<string, unknown> = { ...OK_PAYLOAD };
    delete payload[field];
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
    expect(result.kind).toBe("invalid");
  },
);

it("maps an ok payload carrying an unknown field to invalid", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ...OK_PAYLOAD, extra: SERVER_TEXT }));
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result).toEqual({ kind: "invalid", message: EXPECTED_MESSAGES.invalid });
});

it("rejects a malformed header entry instead of trusting it", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({ ...OK_PAYLOAD, headers: [{ name: "x", value: "1", extra: SERVER_TEXT }] }),
  );
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result.kind).toBe("invalid");
});

it("returns a typed, bounded copy of a valid ok payload", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      kind: "ok",
      status: 201,
      timingMs: 34,
      headers: [{ name: "authorization", value: "[REDACTED]" }],
      bodyText: "hola",
      truncated: true,
    }),
  );
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result).toEqual({
    kind: "ok",
    result: {
      status: 201,
      timingMs: 34,
      headers: [{ name: "authorization", value: "[REDACTED]" }],
      bodyText: "hola",
      truncated: true,
    },
  });
});

it("copies the header list and body so later mutations cannot change the result", async () => {
  const header = { name: "x-a", value: "1" };
  const payload = { ...OK_PAYLOAD, headers: [header], bodyText: "abc" };
  const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  if (result.kind !== "ok") throw new Error("unexpected non-ok result");
  header.value = "MUTATED";
  payload.headers[0] = { name: "x-a", value: "MUTATED" };
  payload.bodyText = "MUTATED";
  expect(result.result.headers).toEqual([{ name: "x-a", value: "1" }]);
  expect(result.result.bodyText).toBe("abc");
  expect(result.result.headers).not.toBe(payload.headers);
  expect(result.result.headers[0]).not.toBe(header);
});

it("maps an oversized 200 body to invalid instead of trusting it", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("a".repeat(200_000), { status: 200 }));
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  expect(result).toEqual({ kind: "invalid", message: EXPECTED_MESSAGES.invalid });
});

it("bounds an over-cap body and marks it truncated", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({ ...OK_PAYLOAD, bodyText: "a".repeat(70_000), truncated: false }),
  );
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
  if (result.kind !== "ok") throw new Error("unexpected non-ok result");
  expect(result.result.bodyText.length).toBe(65_536);
  expect(result.result.truncated).toBe(true);
});

it("uses the global fetch when none is injected", async () => {
  const stub = vi.fn().mockResolvedValue(Response.json(OK_PAYLOAD));
  vi.stubGlobal("fetch", stub);
  const result = await runEndpointTest({ parameters: {} }, { sessionMarker: LIVE });
  expect(stub).toHaveBeenCalledTimes(1);
  expect(result.kind).toBe("ok");
});

it("refuses a non-marker session before issuing any request", async () => {
  const fetcher = vi.fn();
  const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher as MarkerFetch, "nope"));
  expect(result).toEqual({ kind: "session-changed", message: EXPECTED_MESSAGES["session-changed"] });
  expect(fetcher).not.toHaveBeenCalled();
});

it("never surfaces server-supplied text in any failure message", async () => {
  for (const [status] of STATUS_CASES) {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`{"error":"${SERVER_TEXT}"}`, { status }),
    );
    const result = await runEndpointTest({ parameters: {} }, makeIo(fetcher));
    if (result.kind === "ok") throw new Error("unexpected ok result");
    expect(result.message).not.toContain(SERVER_TEXT);
  }
});

it("never logs request or response details", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runEndpointTest(
    { parameters: {} },
    makeIo(vi.fn().mockRejectedValue(new Error(SERVER_TEXT))),
  );
  await runEndpointTest({ parameters: {} }, makeIo(okFetch()));
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

describe("last endpoint-test results", () => {
  it("keeps the last result per node in memory and clears on demand", () => {
    const store = createEndpointTestLastResults();
    const first = { kind: "timeout", message: EXPECTED_MESSAGES.timeout } as const;
    const second = { kind: "denied", message: EXPECTED_MESSAGES.denied } as const;
    expect(store.get("n1")).toBeUndefined();
    store.set("n1", first);
    store.set("n2", second);
    expect(store.get("n1")).toEqual(first);
    expect(store.get("n2")).toEqual(second);
    store.clear("n1");
    expect(store.get("n1")).toBeUndefined();
    expect(store.get("n2")).toEqual(second);
    store.clear();
    expect(store.get("n2")).toBeUndefined();
  });
});
