// Session guard controller (privacy_first_clear). Pure orchestration over an
// injected probe, invalidation hub and window-like event source: no globals,
// no React, no import-time IO. Signals erase protected context immediately and
// keep it blocked until a fresh verification commits; hints never grant auth.
//
// Refinements over the original sketch:
// - `clearProtectedData` is part of the environment because probe.dispose()
//   neither clears nor publishes, so stop() must clear on its own.
// - focus/visible signals arriving while a verification is already in flight
//   are coalesced: that verification started after an invalidation (data is
//   already cleared), and superseding it would hit the probe's occupied slot
//   and commit blocked/unavailable on every ordinary tab switch.
// - The last verified identity is sticky across failed checks, so a silent
//   account/session swap keeps ending identity-changed until a hub "complete"
//   (a legitimate login/logout) resets the expectation.
// - A stopped controller may be restarted without duplicating listeners, but a
//   disposed probe stays inert; callers create a fresh probe per mount.

import type { GuardedSessionProbe, ProbeState, SessionIdentity } from "./guarded-session-probe";
import type { SessionInvalidationHub, SessionInvalidationPhase } from "./session-invalidation";

export type GuardSignal = "focus" | "visibilitychange";

export interface GuardEnv {
  probe: GuardedSessionProbe;
  hub: Pick<SessionInvalidationHub, "subscribe">;
  addEventListener(type: GuardSignal, listener: () => void): void;
  removeEventListener(type: GuardSignal, listener: () => void): void;
  isVisible(): boolean;
  clearProtectedData(): void;
}

export interface SessionGuard {
  start(): void;
  stop(): void;
}

export type SessionView = "authenticated" | "login" | "error";

/**
 * Maps settled probe phases to a page view; null means keep the current view.
 * Pending phases (unknown, verifying, reason-less blocked invalidation) never
 * change the view. Once a session was established, a transient
 * blocked/unavailable keeps the view too: the probe has already erased
 * protected data and the next signal re-verifies. identity-changed and denied
 * always switch. Views never grant access to protected data.
 */
export function sessionViewFor(session: ProbeState, established: boolean): SessionView | null {
  if (session.phase === "verified") return "authenticated";
  if (session.phase === "denied") return "login";
  if (session.phase !== "blocked") return null;
  if (session.reason === "identity-changed") return "error";
  if (session.reason === "unavailable" && !established) return "error";
  return null;
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // Best effort; callers fail closed separately.
  }
}

export function createSessionGuard(env: GuardEnv): SessionGuard {
  const { probe } = env;
  let running = false;
  let unsubscribe: (() => void) | undefined;
  let lastIdentity: SessionIdentity | undefined;

  // verify() is async; a rejection must never become an unhandled rejection.
  const verify = (expected?: SessionIdentity) => {
    void probe.verify(expected).catch(() => {});
  };

  // Any failure inside a signal handler erases protected data (fail closed).
  const handle = (action: () => void) => {
    if (!running) return;
    try {
      action();
    } catch {
      quietly(() => env.clearProtectedData());
    }
  };

  const onHub = (phase: SessionInvalidationPhase) => handle(() => {
    if (phase === "begin") {
      probe.invalidate();
    } else if (phase === "complete") {
      // Login/logout legitimately change identity: verify without expectation.
      lastIdentity = undefined;
      probe.invalidate();
      verify();
    }
  });

  const reverify = () => {
    const state = probe.current;
    if (state.phase === "verifying") return;
    if (state.phase === "verified") lastIdentity = state.identity;
    probe.invalidate();
    verify(lastIdentity);
  };
  const onFocus = () => handle(reverify);
  const onVisibility = () => handle(() => {
    if (env.isVisible()) reverify();
  });

  return {
    start() {
      if (running) return;
      running = true;
      quietly(() => { unsubscribe = env.hub.subscribe(onHub); });
      quietly(() => env.addEventListener("focus", onFocus));
      quietly(() => env.addEventListener("visibilitychange", onVisibility));
      handle(() => verify());
    },

    stop() {
      if (!running) return;
      running = false;
      const release = unsubscribe;
      unsubscribe = undefined;
      quietly(() => release?.());
      quietly(() => env.removeEventListener("focus", onFocus));
      quietly(() => env.removeEventListener("visibilitychange", onVisibility));
      quietly(() => probe.dispose());
      quietly(() => env.clearProtectedData());
    },
  };
}
