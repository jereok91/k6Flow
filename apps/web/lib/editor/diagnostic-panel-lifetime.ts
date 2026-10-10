import { diagnosticMetadataSchema } from "@k6flow/shared";
import { DiagnosticObserver, type DiagnosticObservation, type DiagnosticObserverOptions } from "./diagnostic-polling";
import type { ExecutionDisplay } from "./diagnostic-preparation";
import { diagnosticHistoryStatus, parseDiagnosticSnapshot, type DiagnosticSnapshot } from "./diagnostic-snapshot";

export interface PanelInput {
  runId: string;
  /** Caller-owned generation, NEVER a credential. Advance on every reselection/session change. */
  selectionKey: string | number;
  executionDisplay?: ExecutionDisplay;
  initialSnapshot?: DiagnosticSnapshot;
}
export interface PanelCallbacks {
  onTerminal(result: { runId: string; status: "completed" | "failed" | "stopped" }): void;
  onProtectedDataInvalidated(): void;
}
export interface PanelView {
  readonly runId: string;
  readonly snapshot?: DiagnosticSnapshot;
  readonly executionDisplay?: ExecutionDisplay;
  readonly observation: DiagnosticObservation;
  readonly invalidInput: boolean;
}
export interface PanelSelection {
  readonly runId: string;
  readonly selectionKey: string | number;
  expectedIds?: readonly string[];
  readonly canObserve: boolean;
  view: PanelView;
  terminalNotified: boolean;
  protectedDataInvalidated: boolean;
}

const loading: DiagnosticObservation = Object.freeze({
  availability: "loading", readInFlight: false, stopInFlight: false,
  readUncertain: false, stopUncertain: false,
});

/** Only caller-owned scope is identity. Same-scope props cannot reset receipts or metadata. */
export function resolvePanelSelection(previous: PanelSelection, input: PanelInput): PanelSelection {
  if (Object.is(previous.runId, input.runId) && Object.is(previous.selectionKey, input.selectionKey)) return previous;
  return createPanelSelection(input);
}

export function createPanelSelection(input: PanelInput): PanelSelection {
  let expectedIds: readonly string[] | undefined;
  let display: ExecutionDisplay | undefined;
  let snapshot: DiagnosticSnapshot | undefined;
  let invalidInput = false;
  let canObserve = typeof input.runId === "string" && input.runId.length > 0 && input.runId.length <= 128 &&
    (typeof input.selectionKey === "string" || (typeof input.selectionKey === "number" && Number.isFinite(input.selectionKey)));
  try {
    if (input.executionDisplay) {
      expectedIds = Object.freeze(diagnosticMetadataSchema.parse({
        nodeIds: input.executionDisplay.map(node => node.id),
      }).nodeIds);
      if (new Set(expectedIds).size !== expectedIds.length) throw Error();
      // Whitelist/copy fields; never retain accidental parameters/source/variables.
      display = Object.freeze(input.executionDisplay.map(node => {
        if (typeof node.kind !== "string" || typeof node.disabled !== "boolean" ||
          (node.label !== undefined && typeof node.label !== "string")) throw Error();
        return Object.freeze({ id: node.id, kind: node.kind, label: node.label,
          disabled: node.disabled, position: undefined });
      }));
    }
  } catch {
    invalidInput = true;
    canObserve = false;
    display = undefined;
  }
  try {
    if (input.initialSnapshot !== undefined) {
      snapshot = parseDiagnosticSnapshot(input.initialSnapshot, input.runId, expectedIds);
      expectedIds ??= snapshot.diagnostic.nodeIds;
    }
  } catch {
    invalidInput = true;
    display = undefined;
  }
  if (!canObserve) {
    invalidInput = true;
    snapshot = undefined;
    display = undefined;
  }
  return {
    runId: input.runId, selectionKey: input.selectionKey, expectedIds,
    canObserve,
    view: Object.freeze({ runId: input.runId, snapshot, executionDisplay: display,
      observation: loading, invalidInput }),
    terminalNotified: false, protectedDataInvalidated: false,
  };
}

/**
 * A fresh observer per effect setup; receipts survive StrictMode setup/dispose/setup
 * on the same selection. Caller must invalidate selectionKey on auth/session loss,
 * including external logout/revalidation: late post-timeout 403 is not authority.
 * This adapter cannot guarantee that policy (the page has no session epoch hook).
 */
export function setupPanelLifetime(
  selection: PanelSelection,
  isCurrent: () => boolean,
  callbacks: () => PanelCallbacks,
  update: () => void,
  options: DiagnosticObserverOptions = {},
): { observer: DiagnosticObserver; dispose(): void } {
  let disposed = false;
  const observer = new DiagnosticObserver(observation => {
    if (disposed || !isCurrent()) return;
    if (observation.availability === "forbidden" || selection.protectedDataInvalidated) {
      // Drop known selection metadata, not a claim of physical heap/request-closure wiping.
      const notify = !selection.protectedDataInvalidated;
      selection.protectedDataInvalidated = true;
      selection.expectedIds = undefined;
      selection.view = Object.freeze({ runId: selection.runId, observation: {
        ...observation, snapshot: undefined, availability: "forbidden" as const,
      }, invalidInput: false });
      update();
      if (notify && !disposed && isCurrent()) callbacks().onProtectedDataInvalidated();
      return;
    }
    let snapshot = selection.view.snapshot;
    let invalidInput = selection.view.invalidInput;
    let accepted = false;
    if (observation.snapshot) {
      try {
        snapshot = parseDiagnosticSnapshot(observation.snapshot, selection.runId, selection.expectedIds, snapshot);
        invalidInput = false;
        accepted = true;
      } catch {
        invalidInput = true;
      }
    }
    selection.view = Object.freeze({ ...selection.view, snapshot, invalidInput,
      observation: Object.freeze({ ...observation, snapshot }) });
    update();
    const status = accepted && snapshot ? diagnosticHistoryStatus(snapshot) : undefined;
    if (status && !selection.terminalNotified && isCurrent() && !disposed) {
      selection.terminalNotified = true;
      callbacks().onTerminal({ runId: selection.runId, status });
    }
  }, options);
  if (selection.canObserve && !selection.protectedDataInvalidated && isCurrent()) {
    observer.observe(selection.runId, selection.expectedIds);
  }
  return { observer, dispose() { disposed = true; observer.dispose(); } };
}

type PanelLifetime = ReturnType<typeof setupPanelLifetime>;

/**
 * Component-owned commit gate. Render may create candidate selections, but only
 * layout-effect commit installs callbacks/scope. Abandoned renders do not touch it.
 * This is a panel-specific gate, not a replacement for observer operation guards.
 */
export class PanelCommitBinding {
  private selection?: PanelSelection;
  private callbacks?: PanelCallbacks;
  private lifetime?: PanelLifetime;
  private epoch = 0;

  commit(selection: PanelSelection, callbacks: PanelCallbacks): void {
    if (this.selection !== selection) {
      this.lifetime?.dispose();
      this.epoch++;
      this.lifetime = undefined;
      this.selection = selection;
    }
    this.callbacks = callbacks;
  }

  clear(selection: PanelSelection): void {
    if (this.selection !== selection) return;
    this.lifetime?.dispose();
    this.epoch++;
    this.lifetime = undefined;
    this.selection = undefined;
    this.callbacks = undefined;
  }

  setup(selection: PanelSelection, update: () => void, options: DiagnosticObserverOptions = {}): PanelLifetime | undefined {
    if (this.selection !== selection) return;
    this.lifetime?.dispose();
    const ticket = ++this.epoch;
    const active = setupPanelLifetime(selection,
      () => this.selection === selection && this.epoch === ticket,
      () => this.callbacks!, update, options);
    const lifetime = {
      observer: active.observer,
      dispose: () => {
        if (this.epoch === ticket) {
          this.epoch++;
          this.lifetime = undefined;
        }
        active.dispose();
      },
    };
    this.lifetime = lifetime;
    return lifetime;
  }

  retry(selection: PanelSelection): void {
    if (this.selection === selection) this.lifetime?.observer.retry();
  }

  stop(selection: PanelSelection): void {
    if (this.selection === selection) void this.lifetime?.observer.stop();
  }
}
