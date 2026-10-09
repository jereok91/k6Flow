/**
 * Pure model of the global runs feed (`/ws/runs`, docs/api/ws-metrics.md).
 *
 * `applyRunsMessage` folds one feed message into `{ active, queued }` — the
 * same split as `GET /api/orchestrator/runs/active`. It never mutates its
 * input and returns the previous state object unchanged for messages it
 * does not understand (unknown type, wrong version, malformed payload), so
 * React can bail out of re-renders.
 */

export interface RunItem {
  id: string;
  status: string;
  scenarioId?: string;
  scenarioName?: string;
  vus: number;
  durationMs: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ActiveRunsState {
  active: RunItem[];
  queued: RunItem[];
}

export const EMPTY_RUNS_STATE: ActiveRunsState = Object.freeze({
  active: [],
  queued: [],
}) as ActiveRunsState;

const TERMINAL = new Set(["finished", "failed", "aborted", "errored", "stopped"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export function activeRunsCount(state: ActiveRunsState): number {
  return state.active.length + state.queued.length;
}

/** Parses one socket text frame; null for anything that is not JSON. */
export function parseRunsMessage(data: string): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRunItem(value: unknown): value is RunItem {
  return isRecord(value) && typeof value.id === "string" && value.id !== "" && typeof value.status === "string";
}

function without(list: RunItem[], id: string): RunItem[] {
  return list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : list;
}

/** Upsert keeping position when the run already sits in the target list. */
function upsert(list: RunItem[], item: RunItem): RunItem[] {
  const idx = list.findIndex((r) => r.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function removeRun(state: ActiveRunsState, id: string): ActiveRunsState {
  const active = without(state.active, id);
  const queued = without(state.queued, id);
  if (active === state.active && queued === state.queued) return state;
  return { active, queued };
}

export function applyRunsMessage(state: ActiveRunsState, msg: unknown): ActiveRunsState {
  if (!isRecord(msg) || msg.version !== 1) return state;

  switch (msg.type) {
    case "runs.snapshot": {
      const active = msg.active ?? [];
      const queued = msg.queued ?? [];
      if (!Array.isArray(active) || !Array.isArray(queued)) return state;
      return { active: active.filter(isRunItem), queued: queued.filter(isRunItem) };
    }
    case "runs.state": {
      if (!isRunItem(msg.run)) return state;
      const status = typeof msg.toState === "string" && msg.toState !== "" ? msg.toState : msg.run.status;
      const item: RunItem = { ...msg.run, status };
      if (isTerminalStatus(status)) return removeRun(state, item.id);
      if (status === "queued") {
        return { active: without(state.active, item.id), queued: upsert(state.queued, item) };
      }
      return { active: upsert(state.active, item), queued: without(state.queued, item.id) };
    }
    case "runs.end": {
      if (!isRunItem(msg.run)) return state;
      return removeRun(state, msg.run.id);
    }
    default:
      return state;
  }
}
