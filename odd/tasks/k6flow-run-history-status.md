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
- [ ] T1 Status mapper + PATCH route normalization (tests)
- [ ] T2 Fix stale metrics in RunExecutionPanel onComplete

## Evidence
