import { AsyncLifetime } from "./async-lifetime";
import {
  DIAGNOSTIC_BODY_LIMIT,
  isDiagnosticTerminal,
  parseDiagnosticSnapshot,
  type DiagnosticSnapshot,
} from "./diagnostic-snapshot";

export type DiagnosticFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface DiagnosticReadOptions {
  fetch?: DiagnosticFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type DiagnosticRead = { status: number; data?: unknown };

function bounded(
  n: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n!)) : fallback;
}

interface OwnedOperation {
  /** Logical outcome: bounded even when the transport ignores abort. */
  readonly result: Promise<DiagnosticRead>;
  /** Physical fetch, body read and cleanup have actually settled. */
  readonly drained: Promise<void>;
  readonly pending: boolean;
}

/** Shared owned read. Timeout covers both headers and streaming body. */
export function readOwnedDiagnostic(
  runId: string,
  options: DiagnosticReadOptions = {},
): Promise<DiagnosticRead> {
  return ownedRequest(runId, options, false).result;
}

function ownedRequest(
  runId: string,
  options: DiagnosticReadOptions,
  stop: boolean,
): OwnedOperation {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  let pending = true;

  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new Error("Diagnostic unavailable"));
    };
    timer = setTimeout(abort, bounded(options.timeoutMs, 5000, 1, 10000));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
  });

  const read = async (): Promise<DiagnosticRead> => {
    if (controller.signal.aborted) {
      throw new Error();
    }
    const endpoint = stop ? "stop" : "diagnostic";
    const response = await (options.fetch ?? fetch)(
      `/api/orchestrator/runs/${encodeURIComponent(runId)}/${endpoint}`,
      {
        ...(stop && { method: "POST" }),
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    if (controller.signal.aborted) {
      await response.body?.cancel();
      throw new Error();
    }
    if (stop || response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status };
    }
    if (!response.body) {
      throw new Error();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    let cancellation: Promise<void> | undefined;
    const cancelReader = () => {
      // Retain the first cancellation promise: a second cancel may resolve
      // immediately even while the stream's underlying cleanup is pending.
      cancellation ??= reader.cancel();
      void cancellation.catch(() => {});
    };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) {
          throw new Error();
        }
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > DIAGNOSTIC_BODY_LIMIT) {
          throw new Error();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return { status: 200, data: JSON.parse(text) };
    } finally {
      controller.signal.removeEventListener("abort", cancelReader);
      cancelReader();
      await cancellation;
    }
  };

  const physical = read();
  const drained = physical.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  const result = (async (): Promise<DiagnosticRead> => {
    try {
      return await Promise.race([physical, cancelled]);
    } catch {
      throw new Error("Diagnostic unavailable");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  })();

  return {
    result,
    drained,
    get pending() {
      return pending;
    },
  };
}

export interface DiagnosticObservation {
  readonly runId?: string;
  readonly snapshot?: DiagnosticSnapshot;
  readonly stopState?: "pending" | "acknowledged" | "error";
  readonly availability:
    | "loading"
    | "available"
    | "stale"
    | "unavailable"
    | "forbidden";
  /** Physical operations, not just the bounded logical waits. */
  readonly readInFlight: boolean;
  readonly stopInFlight: boolean;
  /** Logical wait failed while the corresponding transport is still pending. */
  readonly readUncertain: boolean;
  readonly stopUncertain: boolean;
}

type ObservationState = Omit<
  DiagnosticObservation,
  "readInFlight" | "stopInFlight" | "readUncertain" | "stopUncertain"
>;

export interface DiagnosticObserverOptions
  extends Omit<DiagnosticReadOptions, "signal"> {
  intervalMs?: number;
}

/** One lifetime per mounted panel; replacement creates fresh operation slots. */
export class DiagnosticObserver {
  private lifetime = new AsyncLifetime();
  private controller?: AbortController;
  private stopController?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readOperation?: OwnedOperation;
  private stopOperation?: OwnedOperation;
  private readUncertain = false;
  private stopUncertain = false;
  private failures = 0;
  private ids?: readonly string[];
  private value: DiagnosticObservation = Object.freeze({
    availability: "loading",
    readInFlight: false,
    stopInFlight: false,
    readUncertain: false,
    stopUncertain: false,
  });

  constructor(
    private update: (state: DiagnosticObservation) => void,
    private options: DiagnosticObserverOptions = {},
  ) {
    this.lifetime.mount();
  }

  get current(): DiagnosticObservation {
    return this.value;
  }

  observe(runId: string, expectedIds?: readonly string[]): void {
    this.cancel();
    this.lifetime.invalidate();
    const ticket = this.lifetime.capture();
    if (!this.lifetime.isCurrent(ticket)) {
      return;
    }
    this.ids = expectedIds ? [...expectedIds] : undefined;
    this.failures = 0;
    this.readOperation = undefined;
    this.stopOperation = undefined;
    this.readUncertain = false;
    this.stopUncertain = false;
    this.publish(ticket, { runId, availability: "loading" });
    void this.poll(ticket);
  }

  retry(): void {
    const ticket = this.lifetime.capture();
    if (!this.canObserve(ticket) || this.readOperation) {
      return;
    }
    clearTimeout(this.timer);
    void this.poll(ticket);
  }

  /** A stop acknowledgement is not execution authority; polling continues. */
  async stop(): Promise<void> {
    const ticket = this.lifetime.capture();
    const runId = this.value.runId;
    if (
      !this.canObserve(ticket) ||
      !runId ||
      this.stopOperation ||
      this.value.stopState === "acknowledged"
    ) {
      return;
    }
    const controller = new AbortController();
    this.stopController = controller;
    const operation = ownedRequest(
      runId,
      { ...this.options, signal: controller.signal },
      true,
    );
    this.stopOperation = operation;
    this.stopUncertain = false;
    this.publish(ticket, { ...this.value, stopState: "pending" });
    try {
      const result = await operation.result;
      if (!this.lifetime.isCurrent(ticket) || this.value.availability === "forbidden") {
        return;
      }
      if (result.status === 401 || result.status === 403 || result.status === 412) {
        this.deny(ticket);
        return;
      }
      if (this.terminal) {
        return;
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error();
      }
      this.publish(ticket, { ...this.value, stopState: "acknowledged" });
    } catch {
      if (this.lifetime.isCurrent(ticket) && this.value.availability !== "forbidden") {
        this.stopUncertain = operation.pending;
        this.publish(ticket, {
          ...this.value,
          stopState: this.terminal ? undefined : "error",
        });
      }
    } finally {
      // Do not await here: Stop must return at its logical deadline. Only
      // physical drain releases this generation's same-operation gate.
      void operation.drained.then(() => {
        if (!this.lifetime.isCurrent(ticket) || this.stopOperation !== operation) {
          return;
        }
        this.stopOperation = undefined;
        this.stopUncertain = false;
        this.publish(ticket, {
          ...this.value,
          stopState: this.terminal ? undefined : this.value.stopState,
        });
      });
    }
  }

  dispose(): void {
    this.lifetime.unmount();
    this.cancel();
  }

  private get terminal(): boolean {
    return !!this.value.snapshot && isDiagnosticTerminal(this.value.snapshot);
  }

  private canObserve(ticket: number): boolean {
    return this.lifetime.isCurrent(ticket) &&
      !!this.value.runId &&
      this.value.availability !== "forbidden" &&
      !this.terminal;
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.stopController?.abort();
  }

  private deny(ticket: number): void {
    this.publish(ticket, { runId: this.value.runId, availability: "forbidden" });
    this.cancel();
    // Keep the ticket alive only to publish physical drain flags. canObserve
    // prevents retries and the other operation cannot restore protected data.
  }

  private publish(ticket: number, state: ObservationState): void {
    if (!this.lifetime.isCurrent(ticket)) {
      return;
    }
    const readInFlight = this.readOperation?.pending ?? false;
    const stopInFlight = this.stopOperation?.pending ?? false;
    this.value = Object.freeze({
      ...state,
      readInFlight,
      stopInFlight,
      readUncertain: readInFlight && this.readUncertain,
      stopUncertain: stopInFlight && this.stopUncertain,
    });
    this.update(this.value);
  }

  private async poll(ticket: number): Promise<void> {
    const runId = this.value.runId;
    if (!this.canObserve(ticket) || this.readOperation || !runId) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const operation = ownedRequest(
      runId,
      { ...this.options, signal: controller.signal },
      false,
    );
    this.readOperation = operation;
    this.readUncertain = false;
    this.publish(ticket, this.value);
    try {
      const result = await operation.result;
      if (!this.canObserve(ticket)) {
        return;
      }
      if (result.status === 401 || result.status === 403 || result.status === 412) {
        this.deny(ticket);
        return;
      }
      if (result.status !== 200) {
        throw new Error();
      }
      const snapshot = parseDiagnosticSnapshot(
        result.data,
        runId,
        this.ids,
        this.value.snapshot,
      );
      this.failures = 0;
      this.publish(ticket, {
        runId,
        snapshot,
        stopState: this.value.stopState,
        availability: "available",
      });
    } catch {
      if (this.canObserve(ticket)) {
        this.failures++;
        this.readUncertain = operation.pending;
        this.publish(ticket, {
          ...this.value,
          availability: this.value.snapshot ? "stale" : "unavailable",
        });
      }
    } finally {
      void operation.drained.then(() => {
        if (!this.lifetime.isCurrent(ticket) || this.readOperation !== operation) {
          return;
        }
        this.readOperation = undefined;
        this.readUncertain = false;
        this.publish(ticket, this.value);
        if (this.canObserve(ticket) && !this.readOperation) {
          const delay = Math.min(
            30000,
            bounded(this.options.intervalMs, 1000, 1, 30000) *
              2 ** Math.min(this.failures, 5),
          );
          this.timer = setTimeout(() => {
            if (this.lifetime.isCurrent(ticket)) {
              void this.poll(ticket);
            }
          }, delay);
        }
      });
    }
  }
}
