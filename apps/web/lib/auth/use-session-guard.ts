"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createGuardedSessionProbe, type ProbeState } from "./guarded-session-probe";
import { createSessionGuard, type SessionGuard } from "./session-guard";
import { getBrowserSessionInvalidationHub } from "./session-invalidation";

const INITIAL: ProbeState = Object.freeze({ phase: "unknown", epoch: 0 });

/**
 * Thin React binding for the session guard controller. The probe and controller
 * are created only inside the effect, so server rendering never touches
 * window/document and StrictMode remounts get a fresh probe and controller.
 */
export function useSessionGuard(clearProtectedData: () => void): ProbeState & { retry(): void } {
  const [state, setState] = useState<ProbeState>(INITIAL);
  const guardRef = useRef<SessionGuard | null>(null);
  const clearRef = useRef(clearProtectedData);
  clearRef.current = clearProtectedData;

  useEffect(() => {
    const clear = () => clearRef.current();
    const probe = createGuardedSessionProbe({
      fetch: (url, init) => window.fetch(url, init),
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      clearProtectedData: clear,
      publish: setState,
    });
    const guard = createSessionGuard({
      probe,
      hub: getBrowserSessionInvalidationHub(),
      addEventListener: (type, listener) =>
        (type === "focus" ? window : document).addEventListener(type, listener),
      removeEventListener: (type, listener) =>
        (type === "focus" ? window : document).removeEventListener(type, listener),
      isVisible: () => document.visibilityState === "visible",
      clearProtectedData: clear,
    });
    guardRef.current = guard;
    guard.start();
    return () => {
      guard.stop();
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);

  // Memoized per state so consumers can keep depending on its identity.
  return useMemo(() => ({ ...state, retry: () => guardRef.current?.retry() }), [state]);
}
