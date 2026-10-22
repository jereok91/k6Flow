/**
 * Reads `GET /api/runs` (run history) into the rows the executions table renders.
 *
 * The history route keys each run as `runId`, while the table — like the live
 * runs feed — navigates with `id`. Normalizing once here is what keeps a click
 * from pushing `/executions/undefined` (and `/editor?runId=undefined`).
 */

/** One row of the executions table, from either the history route or the feed. */
export interface ExecutionsRunRow {
  /** Key the row opens: `/editor?runId=` for a live run, `/executions/` once terminal. */
  id: string;
  status: string;
  scenarioId?: string;
  scenarioName?: string;
  vus: number;
  durationMs: number;
  /** History sends an ISO string; the live feed sends epoch milliseconds. */
  startedAt?: number | string;
  createdAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The run a history row opens: the route's own `runId`, else an existing `id`. */
function rowId(row: Record<string, unknown>): string | null {
  for (const key of ["runId", "id"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * Normalizes a run-history payload. A row that cannot name the run it opens is
 * dropped rather than rendered as a dead link; every other field is passed
 * through exactly as the API sent it.
 */
export function historyRunRows(payload: unknown): ExecutionsRunRow[] {
  const rows = isRecord(payload) && Array.isArray(payload.runs) ? payload.runs : [];
  const normalized: ExecutionsRunRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = rowId(row);
    if (id === null) continue;
    normalized.push({ ...(row as unknown as Omit<ExecutionsRunRow, "id">), id });
  }
  return normalized;
}
