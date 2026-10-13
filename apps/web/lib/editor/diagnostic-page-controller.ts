import type { DiagnosticClassification } from "./diagnostic-classification";
import type { ExecutionDisplay } from "./diagnostic-preparation";
import type { DiagnosticSnapshot } from "./diagnostic-snapshot";

export type RunKind = "load" | "diagnostic";
export type HistoryStatus = "completed" | "failed" | "stopped";

/** What the page shows for a run; IDs only, never borrowed graph metadata. */
export type DiagnosticSelection =
  | { kind: "closed" }
  | { kind: "classifying"; runId: string }
  | { kind: "unavailable"; runId: string }
  | { kind: "load"; runId: string }
  | {
      kind: "diagnostic";
      runId: string;
      /** Caller generation for the panel; never a credential. */
      key: number;
      executionDisplay?: ExecutionDisplay;
      initialSnapshot?: DiagnosticSnapshot;
    };

export interface DiagnosticPageState {
  /** Shared synchronous latch: load and diagnostic exclude each other. */
  readonly busy: RunKind | null;
  readonly selection: Readonly<DiagnosticSelection>;
}

export interface LaunchToken {
  readonly kind: RunKind;
  readonly id: number;
}

export interface DiagnosticPageDeps {
  /** Usually classifyDiagnosticRun with a session-marker fetch bound in. */
  classify(runId: string, options: { isCurrent(): boolean }): Promise<DiagnosticClassification>;
  /**
   * Observes a launched run whose panel is hidden, so the shared latch lasts
   * until the server reports terminal. Calls done(status) on terminal, or
   * done(null) when the run can no longer be observed (denied, 412). Returns
   * a disposer.
   */
  watch(runId: string, done: (status: HistoryStatus | null) => void): () => void;
  /** Status-only history reconciliation; called at most once per run. */
  reconcile(runId: string, status: HistoryStatus): void;
}

export function statusPatchBody(status: HistoryStatus): { status: HistoryStatus } {
  // Diagnostics have no load metrics: never fabricate averages or error rates.
  return { status };
}

const CLOSED: DiagnosticSelection = Object.freeze({ kind: "closed" });

/**
 * Pure page-level state for diagnostic runs. All IO is injected; React only
 * subscribes. Every transition is synchronous, so a double click in the same
 * tick sees the latch already held.
 */
export class DiagnosticPageController {
  private current: DiagnosticPageState = Object.freeze({ busy: null, selection: CLOSED });
  private holder: LaunchToken | null = null;
  /** The launched diagnostic run that keeps the latch until terminal. */
  private heldRunId: string | null = null;
  private stopWatch: (() => void) | null = null;
  private watchGeneration = 0;
  private reconciled = new Set<string>();
  private nextToken = 0;
  private nextKey = 0;
  /** Bumped by every selection change; stale classifications compare it. */
  private ticket = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: DiagnosticPageDeps) {}

  get state(): DiagnosticPageState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquire(kind: RunKind): LaunchToken | null {
    if (this.holder) return null;
    this.holder = Object.freeze({ kind, id: ++this.nextToken });
    this.publish({ busy: kind });
    return this.holder;
  }

  release(token: LaunchToken): void {
    if (this.holder !== token) return;
    this.freeHold();
    this.publish({ busy: null });
  }

  /** Shows a just-started diagnostic; the latch stays held until terminal. */
  openLaunched(token: LaunchToken, runId: string, executionDisplay?: ExecutionDisplay): boolean {
    if (this.holder !== token || token.kind !== "diagnostic" || this.heldRunId !== null) return false;
    this.ticket++;
    this.heldRunId = runId;
    this.publish({
      selection: { kind: "diagnostic", runId, key: ++this.nextKey, executionDisplay },
    });
    return true;
  }

  /**
   * Records a mounted panel's terminal callback: reconciles the shown or held
   * run once, and returns true when it frees the latch.
   */
  terminal(runId: string, status: HistoryStatus): boolean {
    const selection = this.current.selection;
    const shown = selection.kind === "diagnostic" && selection.runId === runId;
    const held = this.holder !== null && this.heldRunId === runId;
    if (!shown && !held) return false;
    // Capture before reconcile: a re-entrant reconcile must not free a newer hold.
    const token = held ? this.holder : null;
    this.reconcileOnce(runId, status);
    if (!token || this.holder !== token) return false;
    this.release(token);
    return true;
  }

  dispose(): void {
    this.endWatch();
    this.listeners.clear();
  }

  async view(runId: string): Promise<void> {
    const ticket = this.select({ kind: "classifying", runId });
    let result: DiagnosticClassification;
    try {
      result = await this.deps.classify(runId, { isCurrent: () => this.ticket === ticket });
    } catch {
      result = { kind: "unavailable", error: "diagnostic-unavailable" };
    }
    if (this.ticket !== ticket || result.kind === "stale") return;
    if (result.kind === "diagnostic") {
      this.publish({
        selection: { kind: "diagnostic", runId, key: ++this.nextKey, initialSnapshot: result.snapshot },
      });
    } else if (result.kind === "load") {
      this.publish({ selection: { kind: "load", runId } });
    } else {
      this.publish({ selection: { kind: "unavailable", runId } });
    }
  }

  retry(): Promise<void> {
    const selection = this.current.selection;
    return selection.kind === "unavailable" ? this.view(selection.runId) : Promise.resolve();
  }

  close(): void {
    this.select(CLOSED);
  }

  /**
   * privacy_first_clear: erase the diagnostic context synchronously and void
   * any pending diagnostic launch. A load hold stays with its owner because the
   * load run is not diagnostic context and finishes through its own path.
   */
  clearForSession(): void {
    if (this.holder?.kind === "diagnostic") this.freeHold();
    this.ticket++;
    this.current = Object.freeze({ busy: this.holder?.kind ?? null, selection: CLOSED });
    this.emit();
  }

  private select(selection: DiagnosticSelection): number {
    const ticket = ++this.ticket;
    this.publish({ selection });
    // The launched panel is hidden: keep the latch and watch in the background.
    if (this.heldRunId !== null && !this.stopWatch) this.startWatch(this.heldRunId);
    return ticket;
  }

  private startWatch(runId: string): void {
    const generation = ++this.watchGeneration;
    const done = (status: HistoryStatus | null) => {
      const token = this.holder;
      if (generation !== this.watchGeneration || this.heldRunId !== runId || !token) return;
      if (status) this.reconcileOnce(runId, status);
      this.release(token);
    };
    try {
      const returned: unknown = this.deps.watch(runId, done);
      // A missing disposer still counts as an active watch, so no second one starts.
      const stop = typeof returned === "function" ? (returned as () => void) : () => {};
      if (generation === this.watchGeneration && this.heldRunId === runId) this.stopWatch = stop;
      else stop();
    } catch {
      // An unobservable run must not stick the latch forever.
      if (this.holder && this.heldRunId === runId) this.release(this.holder);
    }
  }

  private endWatch(): void {
    this.watchGeneration++;
    const stop = this.stopWatch;
    this.stopWatch = null;
    try {
      stop?.();
    } catch {
      /* Disposal failures are not recoverable here. */
    }
  }

  private freeHold(): void {
    this.endWatch();
    this.holder = null;
    this.heldRunId = null;
  }

  private reconcileOnce(runId: string, status: HistoryStatus): void {
    if (this.reconciled.has(runId)) return;
    this.reconciled.add(runId);
    try {
      this.deps.reconcile(runId, status);
    } catch {
      /* Reconciliation is best effort; history stays as the server has it. */
    }
  }

  private publish(patch: Partial<DiagnosticPageState>): void {
    const selection = patch.selection ? Object.freeze({ ...patch.selection }) : this.current.selection;
    this.current = Object.freeze({ ...this.current, ...patch, selection });
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* One failing subscriber must not block the others. */
      }
    }
  }
}
