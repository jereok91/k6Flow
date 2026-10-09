// Maps orchestrator run statuses onto the run-history vocabulary.
// Pure module: safe to import from client components and API routes alike.

export type HistoryStatus = "running" | "completed" | "failed" | "stopped";

const HISTORY_STATUS_BY_ORCHESTRATOR_STATUS: Readonly<Record<string, HistoryStatus>> = {
  finished: "completed",
  completed: "completed",
  failed: "failed",
  errored: "failed",
  aborted: "stopped",
  stopped: "stopped",
  queued: "running",
  pending: "running",
  starting: "running",
  running: "running",
  stopping: "running",
};

/**
 * Normalizes an orchestrator (or history) status into a history status.
 * Case-insensitive and whitespace-tolerant; returns null for unknown input.
 */
export function toHistoryStatus(status: string | null | undefined): HistoryStatus | null {
  if (typeof status !== "string") return null;
  const key = status.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(HISTORY_STATUS_BY_ORCHESTRATOR_STATUS, key)
    ? HISTORY_STATUS_BY_ORCHESTRATOR_STATUS[key]
    : null;
}
