import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuardedSessionProbe, type GuardedSessionProbe, type ProbeState,
} from "./guarded-session-probe";
import type { SessionInvalidationPhase } from "./session-invalidation";
import { createSessionGuard, sessionViewFor, shouldWipeEditor, type GuardSignal } from "./session-guard";

const A = "a".repeat(64);
const B = "b".repeat(64);
const ok = (sessionMarker = A) => new Response(JSON.stringify({
  id: "u1", username: "alice", role: "user", createdAt: "2024-01-01T00:00:00.000Z", sessionMarker,
}), { status: 200 });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// Arrays (not Sets) so duplicate registrations stay observable.
function harness(markers: string[] = [], probeOverride?: GuardedSessionProbe) {
  const log: string[] = [];
  const states: ProbeState[] = [];
  const listeners: Record<GuardSignal, Array<() => void>> = { focus: [], visibilitychange: [] };
  const hubListeners: Array<(phase: SessionInvalidationPhase) => void> = [];
  const view = { visible: true };
  const probe = probeOverride ?? createGuardedSessionProbe({
    fetch: async () => { log.push("fetch"); return ok(markers.shift() ?? A); },
    setTimer: () => 0,
    clearTimer: () => {},
    clearProtectedData: () => log.push("clear"),
    publish: (state) => { log.push(`publish ${state.phase}`); states.push(state); },
  });
  const guard = createSessionGuard({
    probe,
    hub: {
      subscribe(listener) {
        hubListeners.push(listener);
        return () => { hubListeners.splice(hubListeners.indexOf(listener), 1); };
      },
    },
    addEventListener: (type, listener) => { listeners[type].push(listener); },
    removeEventListener: (type, listener) => {
      const index = listeners[type].indexOf(listener);
      if (index >= 0) listeners[type].splice(index, 1);
    },
    isVisible: () => view.visible,
    clearProtectedData: () => log.push("guard clear"),
  });
  const emit = (type: GuardSignal) => [...listeners[type]].forEach((l) => l());
  const hub = (phase: SessionInvalidationPhase) => [...hubListeners].forEach((l) => l(phase));
  const count = (entry: string) => log.filter((l) => l === entry).length;
  return { probe, guard, log, states, listeners, hubListeners, view, emit, hub, count };
}

async function started(markers?: string[]) {
  const h = harness(markers);
  h.guard.start();
  await flush();
  expect(h.probe.current.phase).toBe("verified");
  h.log.length = 0;
  return h;
}

describe("session guard", { timeout: 3000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts idempotently: one subscription, one listener per signal, one verification", async () => {
    const h = harness();
    h.guard.start();
    h.guard.start();
    await flush();
    expect(h.hubListeners).toHaveLength(1);
    expect(h.listeners.focus).toHaveLength(1);
    expect(h.listeners.visibilitychange).toHaveLength(1);
    expect(h.count("fetch")).toBe(1);
    expect(h.probe.current.phase).toBe("verified");
  });

  it("hub begin invalidates and clears without fetching", async () => {
    const h = await started();
    h.hub("begin");
    await flush();
    expect(h.log).toEqual(["clear", "publish blocked"]);
    expect(h.probe.current).toMatchObject({ phase: "blocked" });
  });

  it("hub complete invalidates and fetches once without an expected identity", async () => {
    const h = await started([A, B]);
    h.hub("complete");
    await flush();
    expect(h.count("fetch")).toBe(1);
    expect(h.log.slice(0, 2)).toEqual(["clear", "publish blocked"]);
    // Login/logout legitimately change identity: B is accepted, not identity-changed.
    expect(h.probe.current).toMatchObject({ phase: "verified", identity: { sessionMarker: B } });
  });

  it("focus invalidates, clears and re-verifies the same identity", async () => {
    const h = await started();
    h.emit("focus");
    expect(h.log.slice(0, 4)).toEqual(["clear", "publish blocked", "clear", "publish verifying"]);
    await flush();
    expect(h.count("fetch")).toBe(1);
    expect(h.probe.current).toMatchObject({ phase: "verified", identity: { sessionMarker: A } });
  });

  it("ignores hidden visibility changes and verifies on visible ones", async () => {
    const h = await started();
    h.view.visible = false;
    h.emit("visibilitychange");
    await flush();
    expect(h.log).toEqual([]);
    h.view.visible = true;
    h.emit("visibilitychange");
    await flush();
    expect(h.log[0]).toBe("clear");
    expect(h.count("fetch")).toBe(1);
    expect(h.probe.current.phase).toBe("verified");
  });

  it("coalesces focus and visible signals while a verification is in flight", async () => {
    const h = await started();
    h.emit("visibilitychange");
    h.emit("focus");
    await flush();
    expect(h.count("fetch")).toBe(1);
    expect(h.probe.current.phase).toBe("verified");
  });

  it("blocks with identity-changed and clears when the marker swaps silently", async () => {
    const h = await started([A, B, A]);
    h.emit("focus");
    await flush();
    expect(h.probe.current).toMatchObject({ phase: "blocked", reason: "identity-changed" });
    expect(h.log.at(-2)).toBe("clear");
    // The last verified identity stays expected: a later focus does not adopt B.
    h.emit("focus");
    await flush();
    expect(h.probe.current).toMatchObject({ phase: "verified", identity: { sessionMarker: A } });
  });

  it("stop removes everything, clears once itself and never publishes again", async () => {
    const h = await started();
    h.guard.stop();
    expect(h.hubListeners).toHaveLength(0);
    expect(h.listeners.focus).toHaveLength(0);
    expect(h.listeners.visibilitychange).toHaveLength(0);
    expect(h.log).toEqual(["guard clear"]);
    h.log.length = 0;
    h.hub("complete");
    h.emit("focus");
    await flush();
    expect(h.log).toEqual([]);
  });

  it("stop discards an in-flight verification without publishing its result", async () => {
    const h = await started();
    h.emit("focus");
    h.guard.stop();
    const published = h.states.length;
    await flush();
    expect(h.states).toHaveLength(published);
    expect(h.count("fetch")).toBe(1);
    expect(h.log.at(-1)).toBe("guard clear");
  });

  it("retry re-verifies with the remembered identity and is a no-op after stop", async () => {
    const h = await started([A, B, A]);
    h.emit("focus");
    await flush();
    expect(h.probe.current).toMatchObject({ phase: "blocked", reason: "identity-changed" });
    h.guard.retry();
    await flush();
    expect(h.probe.current).toMatchObject({ phase: "verified", identity: { sessionMarker: A } });
    h.guard.stop();
    h.log.length = 0;
    h.guard.retry();
    await flush();
    expect(h.log).toEqual([]);
  });

  it("start/stop/start leaves no duplicate listeners", () => {
    const h = harness();
    h.guard.start();
    h.guard.stop();
    h.guard.start();
    expect(h.hubListeners).toHaveLength(1);
    expect(h.listeners.focus).toHaveLength(1);
    expect(h.listeners.visibilitychange).toHaveLength(1);
    h.guard.stop();
    expect(h.hubListeners).toHaveLength(0);
    expect(h.listeners.focus).toHaveLength(0);
  });

  it("isolates probe and environment exceptions and fails closed", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const fail = () => { throw new Error("boom"); };
    const probe: GuardedSessionProbe = {
      current: { phase: "verified", epoch: 0, identity: { userId: "u1", sessionMarker: A } },
      invalidate: fail,
      verify: () => Promise.reject(new Error("rejected")),
      dispose: fail,
    };
    const h = harness([], probe);
    h.guard.start();
    expect(() => h.emit("focus")).not.toThrow();
    expect(h.count("guard clear")).toBe(1);
    expect(() => h.hub("complete")).not.toThrow();
    expect(h.count("guard clear")).toBe(2);
    expect(() => h.guard.stop()).not.toThrow();
    expect(h.count("guard clear")).toBe(3);
    expect(h.listeners.focus).toHaveLength(0);
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("session view mapping", { timeout: 3000 }, () => {
  const identity = { userId: "u1", sessionMarker: A };
  const unavailable: ProbeState = { phase: "blocked", epoch: 1, reason: "unavailable" };
  const changed: ProbeState = { phase: "blocked", epoch: 1, reason: "identity-changed" };
  const denied: ProbeState = { phase: "denied", epoch: 1 };

  it("locks the established editor while verifying, blocked or unknown", () => {
    expect(sessionViewFor(unavailable, true)).toBe("locked");
    expect(sessionViewFor({ phase: "verifying", epoch: 1 }, true)).toBe("locked");
    expect(sessionViewFor({ phase: "blocked", epoch: 1 }, true)).toBe("locked");
    expect(sessionViewFor({ phase: "unknown", epoch: 0 }, true)).toBe("locked");
  });

  it("wipes on session loss or identity change only once established", () => {
    expect(shouldWipeEditor(changed, "u1")).toBe(true);
    expect(shouldWipeEditor(denied, "u1")).toBe(true);
    expect(shouldWipeEditor({ phase: "verified", epoch: 2, identity: { userId: "u2", sessionMarker: B } }, "u1")).toBe(true);
    expect(shouldWipeEditor({ phase: "verified", epoch: 2, identity }, "u1")).toBe(false);
    expect(shouldWipeEditor(unavailable, "u1")).toBe(false);
    expect(shouldWipeEditor({ phase: "verifying", epoch: 1 }, "u1")).toBe(false);
    expect(shouldWipeEditor(denied, null)).toBe(false);
    expect(shouldWipeEditor(changed, null)).toBe(false);
  });

  it("shows the error view for identity changes and the login view for denial once established", () => {
    expect(sessionViewFor(changed, true)).toBe("error");
    expect(sessionViewFor(denied, true)).toBe("login");
  });

  it("shows the error view for an unavailable first check", () => {
    expect(sessionViewFor(unavailable, false)).toBe("error");
    expect(sessionViewFor(changed, false)).toBe("error");
    expect(sessionViewFor(denied, false)).toBe("login");
  });

  it("maps verified to authenticated and pending phases to no change", () => {
    expect(sessionViewFor({ phase: "verified", epoch: 1, identity }, false)).toBe("authenticated");
    expect(sessionViewFor({ phase: "verified", epoch: 1, identity }, true)).toBe("authenticated");
    expect(sessionViewFor({ phase: "unknown", epoch: 0 }, false)).toBeNull();
    expect(sessionViewFor({ phase: "verifying", epoch: 1 }, false)).toBeNull();
    expect(sessionViewFor({ phase: "blocked", epoch: 1 }, false)).toBeNull();
  });
});
