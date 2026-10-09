# k6flow — Run history status persistence

## Problem
On run completion the editor PATCHes `/api/runs/{runId}` and gets `400 {"error":"Invalid status"}`.
- Orchestrator statuses: queued, starting, running, stopping, finished, failed, aborted, errored, stopped.
- History (DB + RunHistoryPanel) statuses: running, completed, failed, stopped.
- RunExecutionPanel forwards the orchestrator status ("finished") unchanged; the route only accepts the history vocabulary.
- RunExecutionPanel `onComplete` reads `metrics` from a stale effect closure, so iterations/avgDuration/errorRate are always 0.

## Decisions
- Single pure mapper `toHistoryStatus()` (finished/completed→completed; failed/errored→failed; aborted/stopped→stopped; queued/pending/starting/running/stopping→running; unknown→null), used by both the client and the PATCH route (route normalizes, so old clients still work).
- Completion metrics come from the fetched summary when available, else a ref holding the latest live metrics.

## Tasks
- [x] T1 Status mapper + PATCH route normalization (tests) — `4780f12`
- [x] T2 Fix stale metrics in RunExecutionPanel onComplete — `4780f12`

## Evidence
- `4780f12`: run-status 19/19 (RED 13 failed -> GREEN), apps/web 20 files / 261 tests pass, tsc clean
- Review lineage review-41ffd38bf8eddef2 approved + acknowledged (advisory: RunExecutionPanel.tsx:62, run-status.test.ts:38)
- Related: `4c4be6c` + `bc00474` deploy/.env.example MAX_* limits (typos fixed)

## Follow-ups
- Polling-only / already-finished completion paths have no summary: iterations stays 0
- updateRunStatus stores round(errorRate*100) and skips avgDurationMs == 0
- Many failing `/api/orchestrator/runs/active` requests seen in the browser (not investigated yet)
