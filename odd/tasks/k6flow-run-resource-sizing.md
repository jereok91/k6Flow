# k6flow — Run resource sizing and OOM handling

## Problem
Runs with many VUs (e.g. 1900) fail with exit code 137 (OOM kill) after ~15s.
- The editor always requests fixed resources: 256 MiB / 500 mCPU (`apps/web/lib/editor/run-scenario.ts:69-70`).
- `MaxVUsPerRun` (default 500) is loaded in `apps/orchestrator/internal/config/config.go` but never enforced.
- The UI shows a generic "script failed" message instead of identifying OOM.

## Decisions
- Orchestrator is the authority on limits: enforce `MAX_VUS_PER_RUN`, `MAX_MEMORY_MIB_PER_RUN`, `MAX_CPU_MILLIS_PER_RUN` with explicit 4xx errors (no silent clamping, which would just OOM again).
- Defaults: VUs 500, memory 4096 MiB, CPU 4000 mCPU. Dev compose raises VUs to 2000 (host: 12 CPU / 64 GB).
- Web sizes resources from VUs: `memoryMiB = 128 + 2 × vus` (min 256), `cpuMillis = 500 + 250 per 100 VUs` (rounded), heuristic documented.
- Exit code 137 is reported as out-of-memory with actionable guidance.

## Tasks
- [x] T1 Orchestrator: enforce VU/memory/CPU limits on start + preflight, config + tests, compose/env docs — `6d01f1c` (deploy/.env.example not updated: blocked by safety policy; error codes kebab-case)
- [ ] T2 Web: compute run resources from VUs (tested helper) and surface orchestrator limit errors in the editor
- [ ] T3 Web: show OOM-specific message for exit code 137 (run panel + executions page)

## Evidence
- T1: `6d01f1c` — go test ./... all ok, go vet clean
