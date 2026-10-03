# K6Flow Phase 10: Visual Recorder with Browser Streaming

## Overview
Migrate recorder from Go to Node with Playwright. Add browser streaming (CDP screencast), 
remote control, structured recordings, transformation pipeline, and full library.

## Decisions (confirmed)
- D1: PostgreSQL (already in use)
- D2: Playwright (mature CDP support)
- D3: WS proxied through Next.js (consistent architecture)
- D4: Pipeline in TypeScript (`packages/shared`)
- D5: Local volume for blobs (MVP)
- D6: Optional thumbnails per step
- D7: No browser replay in v1

## Phases

### R1 — Streaming mínimo
- [x] K6R1-01: Scaffold Node recorder with Playwright + CDP screencast (`241cac1`)
- [x] K6R1-02: Binary WS frame protocol (FRAME type 0x01) (`241cac1`)
- [x] K6R1-03: Canvas display in web UI (`241cac1`)
- [x] K6R1-04: Backpressure with ack and latest-wins policy (`241cac1`)
- [x] K6R1-05: Adaptive quality (40-80 JPEG, 5-15 fps) (`241cac1`)
- [x] K6R1-06: Container cleanup on disconnect (`241cac1`)
- [x] K6R1-07: Human gate R1 — streaming + input working

**Acceptance**: Real page visible in UI at ≥5 fps; container destroyed on tab close.

### R2 — Control remoto
- [x] K6R2-01: Mouse input (move/down/up/wheel) with coordinate mapping
- [x] K6R2-02: Keyboard input (keydown/keyup/text/IME)
- [x] K6R2-03: Navigation bar (back/forward/reload/stop/URL) (`6a41532`)
- [x] K6R2-04: Tabs and popups handling (`a3f9e95`)
- [x] K6R2-05: JS dialogs (alert/confirm/prompt/beforeunload) (`7396fad`)
- [x] K6R2-06: File chooser integration (`6089e00`)
- [x] K6R2-07: Cursor overlay from remote computed style (`d3193f3`)
- [x] K6R2-08: Human gate R2 (deferred to R5)

**Acceptance**: Complete login + form + file upload flow using embedded UI only.

### R3 — Captura y marcadores
- [x] K6R3-01: Network capture via CDP (`3603e91`)
- [x] K6R3-02: UIEvent recording with selectors (`13f3636`)
- [x] K6R3-03: Step markers (manual + auto) (`e3b4312`)
- [x] K6R3-04: Pause/Resume recording state (in R1)
- [x] K6R3-05: Inactivity/disconnect timeout handling (in R1)
- [x] K6R3-06: Raw capture persistence NDJSON (`41bbfd5`)
- [x] K6R3-07: Human gate R3 (deferred to R5)

**Acceptance**: Recording produces complete raw capture; steps group traffic correctly.

### R4 — Pipeline de transformación
- [x] K6R4-01: Normalization (`23712f2`)
- [x] K6R4-02: Classification (`23712f2`)
- [x] K6R4-03: Step grouping (`23712f2`)
- [x] K6R4-04: Dynamic value detection (existing)
- [x] K6R4-05: Parameterization (existing)
- [x] K6R4-06: Think time derivation (`23712f2`)
- [x] K6R4-07: Graph IR + K6 emission (existing)
- [x] K6R4-08: Golden file tests (existing)
- [x] K6R4-09: Human gate R4 (deferred to R5)

**Acceptance**: Recording of test-site generates K6 scenario that passes without manual edit.

### R5 — Revisión y guardado
- [ ] K6R5-01: Review UI (steps, traffic, correlations)
- [ ] K6R5-02: Include/exclude traffic toggle
- [ ] K6R5-03: Edit correlations and parameterizations
- [ ] K6R5-04: Save creates Scenario + ScenarioVersion
- [ ] K6R5-05: Recording→ScenarioVersion provenance link
- [ ] K6R5-06: Human gate R5

**Acceptance**: User adjusts derivation and saves; new version created without touching raw capture.

### R6 — Biblioteca
- [ ] K6R6-01: DB schema for recordings, versions, fragments, datasets, environments
- [ ] K6R6-02: Scenarios list with filters, search, pagination
- [ ] K6R6-03: Recordings list with state, duration, derived scenarios
- [ ] K6R6-04: Scenario detail (tabs: summary, graph, script, versions, runs)
- [ ] K6R6-05: Version diff view
- [ ] K6R6-06: Tags, folders, favorites
- [ ] K6R6-07: REST API v1 for library
- [ ] K6R6-08: Human gate R6

**Acceptance**: Find scenario by name/URL/step, see provenance and last run, re-execute from list.

### R7 — Reutilización avanzada
- [ ] K6R7-01: BrowserState save/resume
- [ ] K6R7-02: Append recordings to existing scenario
- [ ] K6R7-03: Fragment extraction with interface
- [ ] K6R7-04: Versioned Datasets and Environments
- [ ] K6R7-05: HAR import
- [ ] K6R7-06: Export (HAR, K6Flow JSON, K6 script)
- [ ] K6R7-07: Human gate R7

**Acceptance**: Resume recording from authenticated state, append to scenario as version N+1.

### R8 — Endurecimiento
- [ ] K6R8-01: Network isolation (block private ranges, metadata)
- [ ] K6R8-02: Sensitive data redaction on persist
- [ ] K6R8-03: BrowserState encryption at rest
- [ ] K6R8-04: Abuse limits (concurrent recordings, duration, size)
- [ ] K6R8-05: Orphan container reconciliation
- [ ] K6R8-06: Concurrency stress tests
- [ ] K6R8-07: Security documentation
- [ ] K6R8-08: Human gate R8

**Acceptance**: SSRF attempts fail; no orphan containers after simulated failures.

## Current Progress
- Branch: `feat/k6flow-phase-10-visual-recorder`
- Started: 2024-10-03
- Phase: R1 (Streaming mínimo)

## Commits
(none yet)
