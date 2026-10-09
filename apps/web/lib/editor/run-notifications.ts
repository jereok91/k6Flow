import { toHistoryStatus, type HistoryStatus } from "./run-status";

export function normalizedRunStatus(value: unknown): "pending" | HistoryStatus | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase();
  const normalized = toHistoryStatus(status);
  return normalized === "running" && status !== "running" ? "pending" : normalized;
}

export class RunNotifications {
  private runs = new Map<string, { running: boolean; terminal: boolean }>();
  observe(id: string, value: unknown): HistoryStatus | null {
    const status = normalizedRunStatus(value);
    if (!status || status === "pending") return null;
    const previous = this.runs.get(id) ?? { running: false, terminal: false };
    if (previous.terminal || (status === "running" && previous.running)) return null;
    this.runs.set(id, { running: true, terminal: status !== "running" });
    return status;
  }
}

// App-session ownership survives execution panel close/reopen and route remounts.
export const runNotifications = new RunNotifications();
