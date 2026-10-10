import { describe, expect, it } from "vitest";
import {
  createGuardedSessionProbe, SESSION_PROBE_BODY_LIMIT,
  type ProbeDependencies, type ProbeOptions, type ProbeState,
} from "./guarded-session-probe";

const A = "a".repeat(64);
const B = "b".repeat(64);
const user = (over: Record<string, unknown> = {}) => ({
  id: "u1", username: "alice", role: "user", createdAt: "2024-01-01T00:00:00.000Z",
  sessionMarker: A, ...over,
});
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(responses: Array<() => Promise<Response>>, options?: ProbeOptions) {
  const log: string[] = [];
  const states: ProbeState[] = [];
  const inits: RequestInit[] = [];
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  const hooks: { clear?: () => void; publish?: (s: ProbeState) => void } = {};
  const deps: ProbeDependencies = {
    fetch(url, init) {
      log.push(`fetch ${url}`);
      inits.push(init);
      const next = responses.shift();
      return next ? next() : Promise.reject(new Error("unexpected fetch"));
    },
    setTimer(cb, ms) { timers.push({ cb, ms, cleared: false }); return timers.length - 1; },
    clearTimer(handle) { timers[handle as number].cleared = true; },
    clearProtectedData() { log.push("clear"); hooks.clear?.(); },
    publish(state) { log.push(`publish ${state.phase}`); states.push(state); hooks.publish?.(state); },
  };
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => t.cb());
  const fetches = () => log.filter((l) => l.startsWith("fetch")).length;
  return { probe: createGuardedSessionProbe(deps, options), log, states, inits, timers, hooks, fire, fetches };
}

// Body stream whose reads/cancel are driven by the test (optionally abort-ignoring).
function stream(chunks: Uint8Array[], cancel: () => Promise<void> = async () => {}) {
  const pulls: Array<() => void> = [];
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((release) => pulls.push(() => {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk); else controller.close();
        release();
      }));
    },
    cancel() { cancelled += 1; return cancel(); },
  }, { highWaterMark: 0 });
  return { body, step: () => pulls.shift()?.(), cancelled: () => cancelled };
}

describe("guarded session probe", { timeout: 3000 }, () => {
  it("starts unknown without IO", () => {
    const h = harness([]);
    expect(h.probe.current).toEqual({ phase: "unknown", epoch: 0 });
    expect(h.log).toEqual([]);
  });

  it("clears synchronously before publication and IO, then verifies a flat u1 response", async () => {
    const h = harness([async () => ok(user())]);
    const done = h.probe.verify();
    expect(h.log).toEqual(["clear", "publish verifying", "fetch /api/auth/me"]);
    expect(h.probe.current.phase).toBe("verifying");
    const init = h.inits[0];
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.timers[0].ms).toBe(5000);
    await done;
    const state = h.probe.current;
    expect(state).toEqual({ phase: "verified", epoch: 1, identity: { userId: "u1", sessionMarker: A } });
    expect(state.phase === "verified" && Object.isFrozen(state.identity)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(h.timers[0].cleared).toBe(true);
    expect(h.log.at(-1)).toBe("publish verified");
  });

  it.each([
    ["nested user", { user: user(), sessionMarker: A }],
    ["array", [user()]],
    ["null", null],
    ["uppercase marker", user({ sessionMarker: A.toUpperCase() })],
    ["short marker", user({ sessionMarker: A.slice(1) })],
    ["empty id", user({ id: "" })],
    ["numeric id", user({ id: 1 })],
    ["empty username", user({ username: "" })],
    ["unknown role", user({ role: "owner" })],
    ["invalid createdAt", user({ createdAt: "not a date" })],
  ])("blocks an invalid schema: %s", async (_name, data) => {
    const h = harness([async () => ok(data)]);
    await h.probe.verify();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 1, reason: "unavailable" });
  });

  it.each([
    ["invalid JSON", () => new Response("{nope", { status: 200 })],
    ["invalid UTF-8", () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })],
    ["missing body", () => new Response(null, { status: 200 })],
    ["oversized body", () => ok(user({ pad: "x".repeat(SESSION_PROBE_BODY_LIMIT) }))],
    ["500", () => new Response('{"error":"Internal server error"}', { status: 500 })],
    ["other status", () => new Response(JSON.stringify(user()), { status: 203 })],
  ])("blocks unavailable without exposing text: %s", async (_name, make) => {
    const h = harness([async () => make()]);
    await h.probe.verify();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 1, reason: "unavailable" });
  });

  it("maps 401 to denied and network failure to blocked", async () => {
    const h = harness([
      async () => new Response('{"error":"Unauthorized"}', { status: 401 }),
      async () => { throw new TypeError("secret network detail"); },
    ]);
    await h.probe.verify();
    expect(h.probe.current).toEqual({ phase: "denied", epoch: 1 });
    await flush();
    await h.probe.verify();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2, reason: "unavailable" });
  });

  it("requires both expected userId and marker to match", async () => {
    const h = harness([
      async () => ok(user()),
      async () => ok(user({ sessionMarker: B })),
      async () => ok(user({ id: "u2" })),
    ]);
    await h.probe.verify({ userId: "u1", sessionMarker: A });
    expect(h.probe.current.phase).toBe("verified");
    await flush();
    await h.probe.verify({ userId: "u1", sessionMarker: A });
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2, reason: "identity-changed" });
    await flush();
    await h.probe.verify({ userId: "u1", sessionMarker: A });
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 3, reason: "identity-changed" });
    expect(h.log.filter((l) => l === "clear")).toHaveLength(5);
  });

  it("invalidation during headers aborts, clears and suppresses the late response", async () => {
    const headers = deferred<Response>();
    const h = harness([() => headers.promise]);
    const done = h.probe.verify();
    h.probe.invalidate();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
    expect(h.log.slice(-2)).toEqual(["clear", "publish blocked"]);
    expect(h.inits[0].signal?.aborted).toBe(true);
    await done;
    headers.resolve(ok(user()));
    await flush();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
    expect(h.states.map((s) => s.phase)).toEqual(["verifying", "blocked"]);
  });

  it("invalidation during the body cancels the owned reader", async () => {
    const s = stream([new TextEncoder().encode('{"id":"u1"'), new TextEncoder().encode("}")]);
    const h = harness([async () => new Response(s.body, { status: 200 })]);
    const done = h.probe.verify();
    await flush();
    s.step();
    await flush();
    h.probe.invalidate();
    await done;
    await flush();
    expect(s.cancelled()).toBe(1);
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
  });

  it("suppresses a stale A attempt after B, then verifies a fresh A", async () => {
    const first = deferred<Response>();
    const h = harness([() => first.promise, async () => ok(user())]);
    const stale = h.probe.verify({ userId: "u1", sessionMarker: A });
    h.probe.invalidate();
    first.resolve(ok(user({ id: "u2", sessionMarker: B })));
    await stale;
    await flush();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
    await h.probe.verify({ userId: "u1", sessionMarker: A });
    expect(h.probe.current).toMatchObject({ phase: "verified", epoch: 3 });
    expect(h.states.map((s) => s.phase)).toEqual(["verifying", "blocked", "verifying", "verified"]);
  });

  it("times out abort-ignoring headers and holds the slot until physical drain", async () => {
    const headers = deferred<Response>();
    const h = harness([() => headers.promise, async () => ok(user())]);
    const done = h.probe.verify();
    h.fire();
    await done;
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 1, reason: "unavailable" });
    await h.probe.verify();
    expect(h.fetches()).toBe(1);
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2, reason: "unavailable" });
    headers.resolve(ok(user()));
    await flush();
    expect(h.probe.current.phase).toBe("blocked");
    await h.probe.verify();
    expect(h.fetches()).toBe(2);
    expect(h.probe.current.phase).toBe("verified");
  });

  it("times out an abort-ignoring body without awaiting a hanging cancellation", async () => {
    const s = stream([new TextEncoder().encode("{")], () => new Promise<void>(() => {}));
    const h = harness([async () => new Response(s.body, { status: 200 })]);
    const done = h.probe.verify();
    await flush();
    h.fire();
    await done;
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 1, reason: "unavailable" });
    expect(s.cancelled()).toBe(1);
    await h.probe.verify();
    expect(h.fetches()).toBe(1);
  });

  it.each([[undefined, 5000], [50, 1000], [60_000, 10_000], [2500, 2500]])(
    "bounds the deadline option %s to %s ms",
    (timeoutMs, expected) => {
      const h = harness([() => new Promise<Response>(() => {})], { timeoutMs });
      void h.probe.verify();
      expect(h.timers[0].ms).toBe(expected);
    },
  );

  it("dispose aborts, clears timers and suppresses later work", async () => {
    const headers = deferred<Response>();
    const h = harness([() => headers.promise]);
    const done = h.probe.verify();
    const published = h.states.length;
    h.probe.dispose();
    expect(h.inits[0].signal?.aborted).toBe(true);
    expect(h.timers[0].cleared).toBe(true);
    headers.resolve(ok(user()));
    await done;
    await flush();
    h.probe.invalidate();
    await h.probe.verify();
    expect(h.states).toHaveLength(published);
    expect(h.fetches()).toBe(1);
    expect(h.probe.current.phase).toBe("blocked");
  });

  it("isolates throwing callbacks and keeps the installed state", async () => {
    const h = harness([async () => ok(user())]);
    h.hooks.clear = () => { throw new Error("clear failed"); };
    h.hooks.publish = () => { throw new Error("publish failed"); };
    h.probe.invalidate();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 1 });
    await h.probe.verify();
    expect(h.probe.current.phase).toBe("verified");
  });

  it("reentrant invalidate from publish prevents the older verification from fetching", async () => {
    const h = harness([]);
    h.hooks.publish = (s) => { if (s.phase === "verifying") h.probe.invalidate(); };
    await h.probe.verify();
    expect(h.fetches()).toBe(0);
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
  });

  it("reentrant invalidate from clear suppresses the stale publication", () => {
    const h = harness([]);
    let nested = false;
    h.hooks.clear = () => { if (!nested) { nested = true; h.probe.invalidate(); } };
    h.probe.invalidate();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
    expect(h.states).toEqual([{ phase: "blocked", epoch: 2 }]);
  });

  it("reentrant invalidate on verified publication leaves the probe blocked", async () => {
    const h = harness([async () => ok(user())]);
    h.hooks.publish = (s) => { if (s.phase === "verified") h.probe.invalidate(); };
    await h.probe.verify();
    expect(h.probe.current).toEqual({ phase: "blocked", epoch: 2 });
  });
});
