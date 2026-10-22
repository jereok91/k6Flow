/**
 * `GET /api/runs` (run history) keys each run as `runId`, while the executions
 * table navigates with `id`: the id-keyed rows the feed sends. Reading one key
 * from the other shape produced live navigations to `/executions/undefined` and
 * `/editor?runId=undefined`, so the row is normalized here, once, and tested.
 */

import { describe, expect, it } from "vitest";
import { historyRunRows } from "./run-history-row";

const apiRow = {
  runId: "run-1",
  scenarioId: "scenario-1",
  scenarioName: "Cruls",
  status: "completed",
  vus: 4,
  durationMs: 120_000,
  iterations: 12,
  avgDurationMs: 9_800,
  errorRate: 0,
  startedAt: "2026-10-10T12:00:00.000Z",
  completedAt: "2026-10-10T12:02:00.000Z",
};

describe("executions history rows", () => {
  it("keys an API history row by the id the table navigates with", () => {
    expect(historyRunRows({ runs: [apiRow] })).toEqual([
      { ...apiRow, id: "run-1" },
    ]);
  });

  it("keeps an already id-keyed row, so a second pass changes nothing", () => {
    const rows = historyRunRows({ runs: [apiRow] });
    expect(historyRunRows({ runs: rows })).toEqual(rows);
  });

  it("lets the API's own runId decide when a row carries both keys", () => {
    expect(historyRunRows({ runs: [{ ...apiRow, id: "stale-id" }] })).toEqual([
      { ...apiRow, id: "run-1" },
    ]);
  });

  it("drops every row that cannot name the run it opens", () => {
    const rows = historyRunRows({
      runs: [
        apiRow,
        { status: "completed" },
        { runId: "" },
        { runId: "   " },
        { runId: 42 },
        { runId: null },
        null,
        "run-1",
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["run-1"]);
  });

  it("reads an absent or malformed payload as no rows", () => {
    expect(historyRunRows({})).toEqual([]);
    expect(historyRunRows({ runs: null })).toEqual([]);
    expect(historyRunRows(null)).toEqual([]);
    expect(historyRunRows([apiRow])).toEqual([]);
  });
});
