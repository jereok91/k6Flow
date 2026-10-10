// Guarded session probe (privacy_first_clear). Pure dependency-injected
// orchestration: no import-time IO, globals, listeners, storage or React.
//
// Invalidation clears protected context synchronously and blocks until a fresh
// verification commits. "verified" only means a session was observed by that
// response; it never proves perpetual validity or resource ownership.
//
// Availability tradeoff: one physical slot is held until the fetch, body read
// and reader cancellation actually settle, even after invalidation or timeout.
// A verify() issued while that slot is occupied never overlaps a fetch and
// commits blocked/unavailable instead of verifying; callers retry later.

export type SessionIdentity = Readonly<{ userId: string; sessionMarker: string }>;

export type ProbeState =
  | Readonly<{ phase: "unknown" | "verifying" | "denied"; epoch: number }>
  | Readonly<{ phase: "blocked"; epoch: number; reason?: "unavailable" | "identity-changed" }>
  | Readonly<{ phase: "verified"; epoch: number; identity: SessionIdentity }>;

export interface ProbeDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  clearProtectedData(): void;
  publish(state: ProbeState): void;
}

export interface ProbeOptions {
  /** Deadline covering headers and body; bounded to 1–10 s, default 5 s. */
  timeoutMs?: number;
}

export interface GuardedSessionProbe {
  readonly current: ProbeState;
  invalidate(): void;
  verify(expected?: SessionIdentity): Promise<void>;
  dispose(): void;
}

export const SESSION_PROBE_URL = "/api/auth/me";
export const SESSION_PROBE_BODY_LIMIT = 8 * 1024;
const MARKER = /^[0-9a-f]{64}$/;

type Outcome =
  | { kind: "verified"; identity: SessionIdentity }
  | { kind: "denied" }
  | { kind: "unavailable" };
const UNAVAILABLE: Outcome = { kind: "unavailable" };

/** Validates the flat /api/auth/me shape; copies only the identity fields. */
export function parseSessionIdentity(data: unknown): SessionIdentity | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const { id, username, role, createdAt, sessionMarker } = data as Record<string, unknown>;
  const valid =
    typeof id === "string" && id.length > 0 &&
    typeof username === "string" && username.length > 0 &&
    (role === "admin" || role === "user") &&
    typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) &&
    typeof sessionMarker === "string" && MARKER.test(sessionMarker);
  return valid ? Object.freeze({ userId: id, sessionMarker }) : null;
}

function boundedTimeout(ms: number | undefined): number {
  return Number.isFinite(ms) ? Math.min(10_000, Math.max(1_000, ms!)) : 5_000;
}

function guard(callback: () => void): void {
  try {
    callback();
  } catch {
    // Callback failures must never unblock or leak; state stays as installed.
  }
}

interface Operation {
  /** Logical outcome: settles at the first of response, deadline or abort. */
  readonly outcome: Promise<Outcome>;
  /** Physical fetch, body read and cancellation have actually settled. */
  readonly drained: Promise<void>;
  abort(): void;
}

function startOperation(deps: ProbeDependencies, timeoutMs: number): Operation {
  const controller = new AbortController();
  const signal = controller.signal;
  let settled = false;
  let resolve!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((r) => (resolve = r));
  let timer: unknown;
  const settle = (value: Outcome) => {
    if (settled) return;
    settled = true;
    guard(() => deps.clearTimer(timer));
    resolve(value);
  };
  const abort = () => {
    controller.abort();
    settle(UNAVAILABLE);
  };
  timer = deps.setTimer(abort, timeoutMs);

  const physical = async (): Promise<void> => {
    const response = await deps.fetch(SESSION_PROBE_URL, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (signal.aborted || response.status !== 200 || !response.body) {
      settle(signal.aborted || response.status !== 401 ? UNAVAILABLE : { kind: "denied" });
      await response.body?.cancel().catch(() => {});
      return;
    }
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    const cancelReader = () => {
      // Keep the first cancel promise: physical drain waits for real cleanup.
      cancellation ??= reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw new Error();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > SESSION_PROBE_BODY_LIMIT) throw new Error();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const identity = parseSessionIdentity(JSON.parse(text));
      settle(identity ? { kind: "verified", identity } : UNAVAILABLE);
    } catch {
      settle(UNAVAILABLE);
    } finally {
      signal.removeEventListener("abort", cancelReader);
      cancelReader();
      await cancellation;
    }
  };

  // Network errors, thrown fetch and late failures all settle as unavailable.
  const drained = physical().catch(() => settle(UNAVAILABLE));
  return { outcome, drained, abort };
}

export function createGuardedSessionProbe(
  deps: ProbeDependencies,
  options: ProbeOptions = {},
): GuardedSessionProbe {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  let epoch = 0;
  let disposed = false;
  let current: ProbeState = Object.freeze({ phase: "unknown", epoch });
  let active: Operation | undefined;
  let slot: Operation | undefined;

  // Install state, clear synchronously, then publish only if still current so
  // reentrant callbacks cannot resurrect an older state.
  const install = (state: ProbeState) => {
    current = Object.freeze(state);
    if (state.phase !== "verified") guard(() => deps.clearProtectedData());
    if (!disposed && current === state) guard(() => deps.publish(state));
  };

  const supersede = () => {
    epoch += 1;
    active?.abort();
    active = undefined;
  };

  return {
    get current() {
      return current;
    },

    invalidate() {
      if (disposed) return;
      supersede();
      install({ phase: "blocked", epoch });
    },

    async verify(expected) {
      if (disposed) return;
      supersede();
      const mine = epoch;
      const isCurrent = () => !disposed && epoch === mine;
      install({ phase: "verifying", epoch: mine });
      if (!isCurrent()) return;
      if (slot) {
        install({ phase: "blocked", epoch: mine, reason: "unavailable" });
        return;
      }
      const operation = startOperation(deps, timeoutMs);
      active = slot = operation;
      void operation.drained.then(() => {
        if (slot === operation) slot = undefined;
      });
      const result = await operation.outcome;
      if (active === operation) active = undefined;
      if (!isCurrent()) return;
      if (result.kind === "denied") {
        install({ phase: "denied", epoch: mine });
      } else if (result.kind === "unavailable") {
        install({ phase: "blocked", epoch: mine, reason: "unavailable" });
      } else if (
        expected &&
        (expected.userId !== result.identity.userId ||
          expected.sessionMarker !== result.identity.sessionMarker)
      ) {
        install({ phase: "blocked", epoch: mine, reason: "identity-changed" });
      } else {
        install({ phase: "verified", epoch: mine, identity: result.identity });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      supersede();
      current = Object.freeze({ phase: "blocked", epoch });
    },
  };
}
