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
  /** Re-verifies with the remembered identity; no-op once stopped. */
  retry(): void;
}

export type SessionView = "authenticated" | "locked" | "login" | "error";

/**
 * Maps probe phases to a page view; null means keep the current view.
 * identity-changed and denied always switch. Once a session was established,
 * every other non-verified phase locks the editor (kept mounted, unusable)
 * until the same identity verifies again. Before establishment, pending phases
 * keep the loading view and an unavailable first check shows the error view.
 */
export function sessionViewFor(session: ProbeState, established: boolean): SessionView | null {
  if (session.phase === "verified") return "authenticated";
  if (session.phase === "denied") return "login";
  if (session.phase === "blocked" && session.reason === "identity-changed") return "error";
  if (established) return "locked";
  if (session.phase === "blocked" && session.reason === "unavailable") return "error";
  return null;
}

/**
 * True when identity-scoped editor data must be erased: the session that
 * established the editor was lost (denied), silently swapped
 * (identity-changed) or replaced by a different verified user.
 */
export function shouldWipeEditor(session: ProbeState, establishedUserId: string | null): boolean {
  if (establishedUserId === null) return false;
  if (session.phase === "denied") return true;
  if (session.phase === "blocked") return session.reason === "identity-changed";
  return session.phase === "verified" && session.identity.userId !== establishedUserId;
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

    retry() {
      handle(reverify);
    },
  };
}
