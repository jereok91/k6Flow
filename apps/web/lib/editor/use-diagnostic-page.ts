"use client";

import { useEffect, useRef, useState } from "react";
import { isSessionMarker, withSessionMarker, type MarkerFetch } from "../auth/session-marker-header";
import { classifyDiagnosticRun } from "./diagnostic-classification";
import {
  DiagnosticPageController,
  type DiagnosticPageDeps,
  type DiagnosticPageState,
  type HistoryStatus,
} from "./diagnostic-page-controller";
import { DiagnosticObserver } from "./diagnostic-polling";
import { diagnosticHistoryStatus, isDiagnosticTerminal, type DiagnosticSnapshot } from "./diagnostic-snapshot";

export interface DiagnosticPageIO {
  fetch: MarkerFetch;
  /** The marker of the currently verified session, or null while unverified. */
  getMarker(): string | null;
  reconcile(runId: string, status: HistoryStatus): void;
}

/** Terminal trace → history status; never undefined for a terminal snapshot. */
function terminalStatus(snapshot: DiagnosticSnapshot): HistoryStatus {
  return diagnosticHistoryStatus(snapshot) ?? "failed";
}

/** Binds the controller's IO to the session-marker transport. */
export function createDiagnosticPageDeps(io: DiagnosticPageIO): DiagnosticPageDeps {
  return {
    async classify(runId, { isCurrent }) {
      const marker = io.getMarker();
      if (!isSessionMarker(marker)) return { kind: "unavailable", error: "diagnostic-unavailable" };
      return classifyDiagnosticRun(runId, { fetch: withSessionMarker(io.fetch, marker), isCurrent });
    },
    watch(runId, done) {
      const marker = io.getMarker();
      if (!isSessionMarker(marker)) {
        done(null);
        return () => {};
      }
      let finished = false;
      const observer = new DiagnosticObserver(observation => {
        if (finished) return;
        if (observation.availability === "forbidden") {
          finished = true;
          observer.dispose();
          done(null);
        } else if (observation.snapshot && isDiagnosticTerminal(observation.snapshot)) {
          finished = true;
          observer.dispose();
          done(terminalStatus(observation.snapshot));
        }
      }, { fetch: withSessionMarker(io.fetch, marker) });
      observer.observe(runId);
      return () => {
        finished = true;
        observer.dispose();
      };
    },
    reconcile: (runId, status) => io.reconcile(runId, status),
  };
}

const IDLE: DiagnosticPageState = Object.freeze({ busy: null, selection: Object.freeze({ kind: "closed" as const }) });

/**
 * Thin React binding: one controller per mount, created only in the effect so
 * server rendering and StrictMode remounts never reuse a disposed controller.
 */
export function useDiagnosticPage(io: Omit<DiagnosticPageIO, "fetch">): {
  controller: DiagnosticPageController | null;
  state: DiagnosticPageState;
} {
  const ioRef = useRef(io);
  ioRef.current = io;
  const [controller, setController] = useState<DiagnosticPageController | null>(null);
  const [state, setState] = useState<DiagnosticPageState>(IDLE);
  useEffect(() => {
    const created = new DiagnosticPageController(createDiagnosticPageDeps({
      fetch: (url, init) => window.fetch(url, init),
      getMarker: () => ioRef.current.getMarker(),
      reconcile: (runId, status) => ioRef.current.reconcile(runId, status),
    }));
    const off = created.subscribe(() => setState(created.state));
    setController(created);
    setState(created.state);
    return () => {
      off();
      created.dispose();
      setController(current => (current === created ? null : current));
    };
  }, []);
  return { controller, state };
}
