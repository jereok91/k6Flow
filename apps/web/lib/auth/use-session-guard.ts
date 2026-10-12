"use client";

import { useEffect, useRef, useState } from "react";
import { createGuardedSessionProbe, type ProbeState } from "./guarded-session-probe";
import { createSessionGuard } from "./session-guard";
import { getBrowserSessionInvalidationHub } from "./session-invalidation";

const INITIAL: ProbeState = Object.freeze({ phase: "unknown", epoch: 0 });

/**
 * Thin React binding for the session guard controller. The probe and controller
 * are created only inside the effect, so server rendering never touches
 * window/document and StrictMode remounts get a fresh probe and controller.
 */
export function useSessionGuard(clearProtectedData: () => void): ProbeState {
  const [state, setState] = useState<ProbeState>(INITIAL);
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
    guard.start();
    return () => guard.stop();
  }, []);

  return state;
}
