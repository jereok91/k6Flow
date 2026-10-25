# K6Flow — Recorder capture flow (stop, persist, review, save)

Scope: make the visual recorder module work end to end — stop really stops and persists the
capture, review opens the capture that was just recorded, and saving produces a scenario linked
to its recording. Recorder service plus web proxy, review and recordings screens.

## Specs

S1 (verbatim, user): "grabo interactuo con el navegado le doy detener pero no hace nada no guarda nada"
  - Stopping a recording ends the recorder session and writes a complete NDJSON capture
    (final `end` event included) before the stop request answers.
  - That capture is retrievable after the stop, in a later session and after a recorder
    restart, so nothing captured is lost.

S2 (verbatim, user): "ayudame ajustar qeu gusrade bien todo el modulo de garabar"
  - The module works end to end: start → interact → stop → review → save as scenario → list.

S3 (derived from S1): the UI never reports success for a stop that did not happen. A stop
  that the recorder rejects surfaces the error and keeps the session visible for a retry.

S4 (derived from S1): after a successful stop, review loads the capture of that exact
  recording by id — the user does not have to find or upload an `.ndjson` file. Manual upload
  stays available as a fallback.

S5 (derived from S2): saving from review creates the scenario and links it to the recording
  that produced it, and the recordings list shows it with its real state and start URL.

S6 (derived from S1): the recording id is authoritative and comes from the recorder. A client
  never invents one, so the id used for the WebSocket, the stop, the capture and the review is
  always the same one.

S7 (verbatim, user): "no me guardo request hay algo raro cuando capturo cuando inetento capturar los flujos"
  - A recorded step shows the requests that happened during it. A capture whose network events and
    step markers come from different clocks (CDP monotonic seconds vs wall clock ms) must still
    group every request into the step that follows it in the append-only log, and must not lose the
    requests that precede the first marker.
  - New captures carry one clock: network events are stamped with wall-clock time, with the CDP
    numbers kept only to measure durations.

S8 (verbatim, user): "ademas no se ve igual que el resto de apps" / "debes alinear el esto de esta vsiata"
  - The review screen uses the application shell and design tokens (sidebar, cards, buttons,
    typography, Spanish copy) like the recorder and recordings screens, instead of a standalone
    dark page.

## Tasks

- T1 — Recorder: await the capture flush, return the stopped id/event count/duration from
  `/stop`, answer `idle` honestly, and serve `GET /captures/:id` with id validation. Route:
  inline. Commit: `9f3accd`.
- T2 — Web API: `/api/recorder/stop` persists the capture into `recordings` and reports what
  it saved; `GET /api/recordings/[id]` serves the capture; `POST /api/recordings` links the
  scenario to its recording. Route: inline. Commit: `c2f439e`.
- T3 — Recorder page: adopt the recorder's recording id, honest stop result with retry, and
  hand off to review with that id. Route: inline. Commit: `8a175e5`.
- T4 — Review page: load `?id=` capture automatically, keep the upload fallback, handle
  captures without steps, send the recording id when saving. Route: inline. Commit: `8a175e5`.
- T5 — Recordings list: read the fields the API really returns (`startUrl`, `state`) and open
  review by id. Route: inline. Commit: `8a175e5`.
- T6 — Deploy: give the web container the recorder token and keep captures on a volume so a
  recorder restart does not lose them. Route: inline. Commit: `8a175e5`.
- T7 — Checks: typecheck, recorder integration tests, web unit tests, live stop→save run.
  Route: inline implementation; live run delegated to `gentle-ai-verify` (read-only, bounded).
  Commit: none (verification only).
- T8 — Library versions: saving a recording as a *new* scenario writes version 1 of the graph
  it produced, with the recording as provenance; append path unchanged and covered. Route:
  inline. Commit: `736000c`.
- T9 — Deploy docs: recorder token (shared by web and recorder) and its two recording limits
  documented in the deployment table, plus the capture volume and stop→library copy. Route:
  inline. Commit: `9ef6933`.

- T10 — Grouping: `groupBySteps` follows the capture log order (steps as separators) instead of
  sorting mixed clocks, and `calculateThinkTimes` ignores timestamps from another clock. Route:
  inline. Commit: `9130b80`.
- T11 — Recorder: network events are stamped with wall-clock time; CDP numbers stay in `timing`
  for durations. Route: inline. Commit: `bd4cfac`.
- T12 — Review screen: rebuilt on `MainLayout` with the design tokens, Spanish copy, per-step
  request counts, method/status/classification badges and an actionable save bar. Route: inline.
  Commit: `50bc7f4`.

## Log

- L1 (user, verbatim): "Ahora ayudame con las grabaciones revsia todo este modulo ya que grabo
  interactuo con el navegado le doy detener pero no hace nada no guarda nada, ayudame ajustar
  qeu gusrade bien todo el modulo de garabar,"
- L2 (diagnosis, evidence): the recorder side already writes captures
  (`/tmp/captures/<id>.ndjson`, `end` event with `reason: "manual"`), so the stop reaches the
  service. What fails is everything after it: `apps/web/app/recorder/page.tsx` ignores
  `res.ok` and always shows "Grabación Completada"; no handler ever inserts into the
  `recordings` table (`captureData` column unused, `select count(*) from recordings` = 0);
  `apps/web/app/recorder/review/page.tsx` ignores `?id=` and only accepts a manual file
  upload, which the browser cannot produce. `/recordings` also reads `targetUrl`, a field the
  API never returns.
- L3 (decision): captures are persisted in `recordings.capture_data` (schema already declares
  it, DB has a volume, recorder `/tmp` does not). The recorder keeps its file and serves it;
  the web proxy reads it once at stop and stores it, so review works with a plain HTTP GET and
  survives a recorder restart.
- L4 (decision): one recording at a time stays the recorder contract. The page adopts the
  returned `recordingId` (new or `reconnected`) instead of generating its own, which removes
  the id-mismatch class of bugs (WS input ignored, stop targeting another capture).
- L5 (slices): `9f3accd` recorder service + its tests; `c2f439e` web persistence API + its
  tests; `8a175e5` UI flow, list, compose wiring and this document. Three reviewable slices,
  each carrying its tests.
- L6 (verification): `pnpm typecheck` clean; recorder suite 23/23 (real Chromium); web+shared
  suite 2111/2111. Live run by `gentle-ai-verify` (background task `mvmv758p-1-nh5l`) against
  the dev stack: start 200 → stop 200 `persisted:true` (2 requests, 1 step, 7047 ms, 7590 B) →
  `GET /api/recordings/<id>` 200 with the capture → `POST /api/recordings` 200 with scenario id
  → list shows the recording `completed` with that `scenarioId`; unknown id 404; DB restored
  (recordings 0, scenarios 7).
- L7 (fix from L6): a repeat stop re-persisted `duration_ms` from a second source (7540 vs the
  7047 the first stop measured), because the capture was still readable. A stop for a recording
  already saved is now idempotent: it answers the stored row and rewrites nothing. Pinned by
  `apps/web/app/api/recorder/stop/route.test.ts` ("leaves an already saved recording untouched")
  and re-checked live: stop1 = stored = stop2 = 4133 ms.
- L8 (follow-up, resolved in T8): saving a *new* scenario from a recording inserted no v1 row
  in `scenario_versions` while the append path did. Saving now writes version 1 of the graph it
  produced (`Created from recording: <name>`, `sourceRecordingId` = the recording). Live check:
  `GET /api/scenarios/<id>/versions` returns `version: 1` with that description, and the DB row
  carries the recording id; DB restored afterwards (recordings 0, scenarios 7, sessions 10).
  Pinned by `apps/web/app/api/recordings/route.test.ts` (5 tests, append behavior included).
- L9 (deploy docs): `deploy/.env.example` is a policy-protected path for the agent, so the
  recorder variables are documented in `docs/DEPLOYMENT.md` and next to their defaults in
  `deploy/docker-compose.yml`; the operator pastes the block into their own `.env`. The pending
  ceiling values in `.env.example` were committed as-is (`bda6843`) so the example stops
  drifting from the running configuration.
- L11 (native review `review-38336b6c81a8adf7`, tier medium, 4 lenses + refuter): closed
  `escalated` — `R3-001` causality unknown, four other findings corroborated with "probe
  unavailable on pi". Findings and disposition:
  - `R1-001` BLOCKER (capture stop/claim before ownership) → **fixed**: starting reserves the
    library row for the caller, and stop refuses 400/404/403 before the recorder is called.
    Live: stop as another user → 403 with the recorder still `RECORDING`; no id → 400;
    unknown id → 404; owner → `persisted:true` with counts.
  - `R4-001`/`R1-003`/`R3-003` (flush failure reported as success) → **fixed**: `end()`
    rejects and the stop surfaces the failure.
  - `R4-002` (duplicate stop opens a second teardown) → **fixed**: stops join the in-flight
    teardown; pinned by a lifecycle test (one `end` event, both answers 200).
  - `R3-001` (teardown closes a later recording's writer) → **fixed** by owning the writer
    reference before the first await, plus `finally`-style close (also `R4-003`).
  - `R3-002` (concurrent stops overwrite the terminal row) → **fixed**: conditional upsert
    (`state <> 'completed'`) and the answer is the stored row; pinned by a route test.
  - `R4-004` (save not atomic) → **fixed**: scenario + version 1 + link in one transaction.
  - `R4-005` (health poll looping on 409) → **fixed**: a 409 now means "this recording
    already ended", so its capture is collected and the page completes.
  - `R3-004` (unreadable capture could kill the process) → **fixed**: guarded read answers 404.
  - `R2-*` readability → **fixed**: no client-invented recording id, provenance only after a
    successful load (upload clears it), one mapper for stored answers, name uses `startedAt`.
  - `R1-002`/`R4-006`/`R3-005` (raised ceilings in `deploy/.env.example`) → **kept, flagged**:
    they are the operator's own pending values, committed separately in `bda6843` so they can
    be dropped alone if the reviewer prefers the baseline guard in the example.
- L13 (second native review `review-a208921732815761`, medium, 4 lenses + refuter): also
  closed `escalated` (`R4-002` unknown causality). Fixes in `b0e033b` and `88749a7`:
  - `R1-002`/`R4-001`/`R3-001`/`R2-001` (one regression, four lenses) → **fixed**: a refused start
    no longer stops the session it failed to adopt. Only a session the request itself created is
    abandoned, and a `reconnected` answer never is. Live: U2 start → 409 and the recorder still
    reports `RECORDING` for U1.
  - `R1-003`/`R3-002`/`R4-003` → **fixed**: a capture without its end marker answers
    `persisted:false` `Capture incomplete`, and saving a recording only links provenance instead
    of marking it completed. Live: partial capture → `persisted:false`, row stays `recording`,
    file kept for a retry.
  - `R4-002` → **fixed**: the browser teardown is bounded (10s) and the writer is closed after it,
    so a hung close cannot hold the capture open.
  - `R4-004` → **fixed**: `DELETE /captures/:id` releases the recorder-side file once the library
    has it. Live: capture gone after a persisted stop.
  - `R1-004` → **fixed**: provenance ids are ownership-checked; a foreign id is dropped.
  - `R2-002`/`R2-003`/`R2-004` → **fixed**: shared request-field helpers, `endEvent` naming,
    `Pick<…, "update">` instead of a nested `ReturnType`/`Parameters` alias.
  - `R1-001` (the start answer carries the recorder token in `wsUrl`) → **kept, documented**: the
    recorder is one shared session for the whole installation and its token was already browser
    side through `NEXT_PUBLIC_RECORDER_TOKEN`; a per-user WS token needs a new recorder auth
    design, out of this feature's scope.
  - `R1-005`/`R4-005`/`R3-003` (raised ceilings in `deploy/.env.example`) → **owner's call**, kept
    in `bda6843`; `git revert bda6843` restores the baseline guard.
- L15 (third native review `review-b98d3c5c9dbab918`): `correction_required` with 1 BLOCKER +
  5 CRITICAL (`R1-001`, `R1-002`, `R3-001`, `R3-002`, `R3-003`, `R4-001`). Bounded correction
  declared at 92 diff lines (budget 200) and applied in `d2944c2`:
  - The start route no longer forwards a client-supplied `recordingId` (the recorder mints it),
    so a caller can neither name another user's recording nor replay a finished one.
  - A row already `completed` is refused with 409 and the just-started session is abandoned.
  - A recorder 409 on stop is only forgiven when the capture proves the recording ended;
    otherwise the rejection is relayed so the UI keeps the session.
  - Provenance requires ownership (no admin bypass), matching the owner-scoped link.
  Ordering note: the correction plan must be captured **before** the candidate changes, so the
  fix was temporarily rolled back (`dfc01d5`) and re-applied (`7ddf0eb`) to satisfy the binding.
  The provider's `targeted_validation` collect binding was rejected twice by the facade
  (`does not carry one non-empty matching provider lineage and target token`, then
  `missing or stale for current STATUS`) even against the exact tree the provider names; the
  owner chose a fresh review instead of pursuing that route.
- L16 (fourth native review `review-93c2fb37be6e23b8`, fresh START on the corrected candidate):
  closed `escalated` (`R1-002`/`R4-001` causality unknown). Fixes in `b446c71`, `dcb9242`,
  `8bc2e4b`:
  - `R1-001` (no size cap on a capture read/persisted) → fixed: `RECORDER_MAX_CAPTURE_BYTES`
    (32 MiB default) refuses oversized captures with `persisted:false`.
  - `R4-001` (a timed-out browser teardown still wrote a plain end marker) → fixed: the end
    event carries `incomplete:true` and the web tier treats that capture as partial.
  - `R1-003`/`R1-004` → fixed: foreign recordings answer 404 in both detail and stop routes, and
    a refused stop relays a generic body (the recorder's body names the live session).
  - `R4-003`/`R4-004`/`R4-005`/`R3-004` → fixed: DB failure answers 503, a duplicate stop that
    loses the race to the capture delete answers with the stored row, and the completed path
    retries a delete that failed earlier.
  - `R3-001`/`R3-002`/`R3-003` → fixed: the page bounds the stop request (30s abort) and stops
    polling after a 409; the start route survives a literal `null` body.
  - `R2-001`/`R2-002`/`R2-003`/`R2-004` → fixed: `||` fallbacks for the capture URL and name, a
    malformed recorder answer is reported as such, and the reconnect-refusal test now uses a
    reconnected answer.
  - `R1-002`/`R4-002`/`R2-005`/`R3-005` (raised ceilings in `deploy/.env.example`) → still the
    owner's call at that point; flagged by every round.
  Live after the rebuild: U2 reading U1's recording → 404; U1 stop → `persisted:true`, capture
  released, row `completed`. Dev DB back to the owner's two recordings.
- L17 (slice boundaries): recorder durability/ownership rounds `ed19c86`, `6a424bc`, `b0e033b`,
  `88749a7`, `b446c71`, `0128394` · web rounds `255d732`, `d2944c2`/`7ddf0eb`, `dcb9242`,
  `e69630f`, `8eb0035` · library/docs `736000c`, `9ef6933`, `fd796a9`, `f1c79e6`, `756c270`,
  `5a64fb0`, `8d960bb`.
- L18 (fifth native review `review-6402ebf9e5663ba7`): closed `escalated` (`R4-001` causality
  unknown; the rest corroborated). Fixes in `0128394`, `e69630f`:
  - `R1-001` (ownership decided by a read-then-insert race: the first caller to commit owned a
    live session it did not start) → fixed: a `reconnected` answer is adoptable only by the
    owner of its row, decided before any write, plus a post-upsert confirmation read. Live: U2
    start while U1 records → 409 `Recorder is busy with another recording`, U1 untouched.
  - `R4-002`/`R3-001` (the recorder buffered the whole capture before the web cap applied) →
    fixed: the size is stat-ed first (`MAX_CAPTURE_BYTES`, 32 MiB) and an oversized file answers
    413 without being read.
  - `R4-003`/`R4-004`/`R3-005` (an unusable capture left the row `recording` and the file on the
    volume) → fixed: `failed` state plus release — the release was later removed for partial
    captures in L19 because it destroyed the only copy.
  - `R1-002`/`R3-002`/`R2-003`/`R2-004`/`R3-004`/`R3-006`/`R2-001`/`R2-002` → fixed: null stop
    body, malformed 2xx parsed as such, viewport preserved across the stop, a refused stop looks
    for a row a retry saved, the poll flag resets on a new recording, review links only
    provenance it loaded.
  Live after rebuilding: busy refusal, normal stop persisted, partial capture terminal.
- L20 (user, verbatim): "ayudame con esto auto • 0 requests • 2.3s think time ... no me guardo
  request hay algo raro cuando capturo cuando inetento capturar los flujos" and "ademas no se ve
  igual que el resto de apps". Evidence from their recording `rec-1792885685861`:
  `network_entry.request.timestamp` = 339305349.278 (CDP monotonic seconds) while
  `step.data.timestamp` = 1792885691367 (wall clock ms) and `ui_event` = 1792885691559. Sorting
  mixed clocks put all 105 entries before the first step (log index 18), and `groupBySteps` drops
  everything before the first marker, so every step reported 0 requests and the think times became
  plain step-to-step gaps.
- L21 (fix + evidence for S7/S8): `9130b80` groups by log order — replayed against the owner's
  recording `rec-1792885685861` it now yields 12 steps with 105 requests distributed (5/18/26/4/10/
  10/4/7/4/13/0/4) and sane think times, instead of 0/0 everywhere. `bd4cfac` makes new captures
  coherent: after rebuilding the recorder, a fresh recording reported `step ts 1792886520507` and
  `entry ts 1792886516010` in the same clock. `50bc7f4` rebuilds the review screen on the app
  shell; both the new and the old recording answer HTTP 200 through the page. Suites: 109 test
  files / 2142 tests + 28 recorder tests green, `pnpm typecheck` clean.
- L22 (seventh native review `review-a466f6f1fab14fb4`, over the grouping fix and the review
  screen): `correction_required` with `R1-001` CRITICAL in scope — the oversized-capture branch
  deleted the only copy after refusing to store it, i.e. the same data-loss class as round 6.
  Fixed in `579a1ad` (3 diff lines of a 12-line plan): an oversized capture is marked `failed`
  and its file is kept; deleting now only happens after the library holds the capture.
  The `targeted_validation` route was rejected again by the facade, third time, so the correction
  cannot be validated natively. Warnings left as follow-ups: a 409 plus an incomplete capture
  leaves the row `recording` for the UI to retry forever (mark it `failed` before relaying), a
  partial capture that is kept is not stored in the library so the review screen cannot open it,
  the capture delete is fire-and-forget, and the capture-size limit has one name per tier.
- L19 (sixth native review `review-58cc0e53c121e697`): `correction_required` with 1 BLOCKER +
  4 CRITICAL (`R1-001`, `R3-001`, `R4-001`, `R4-002`, `R4-003`). Bounded plan declared at 45 diff
  lines, applied in 39 (`8eb0035`):
  - `R1-001`/`R4-001` (the round-5 cleanup deleted the only capture copy of a partial capture
    while the review screen still offers a manual upload) → fixed: an incomplete capture is
    marked `failed` but its file is **kept**. Live: partial stop → `persisted:false`, row
    `failed`, `CAPTURE_KEPT_FOR_MANUAL_UPLOAD`.
  - `R3-001` (a recorder 413 was not recognised as oversized, so the row and file were left
    behind) → fixed: 413 counts as oversized and reaches the terminal state.
  - `R4-002` (a failed capture fetch was collapsed with a 404 into "Capture unavailable") →
    fixed: an unreachable recorder answers 502 and leaves the recording retryable.
  - `R4-003` (raised ceilings in the deployment example) → fixed by returning the example to the
    baseline 500/4096/4000; raising them is the operator's decision in their own env file.
    `bda6843` is therefore neutralised by this correction.
  The provider's `targeted_validation` collect binding was rejected again by the facade
  (`collectBinding is missing or stale for current STATUS`) even though it was issued against
  the current tree — the same unreachable route as round 3, now confirmed independent of
  staleness. The correction stands committed; the lineage stays `correction_required`.
  - `R1-001` (ownership decided by a read-then-insert race: the first caller to commit owned a
    live session it did not start) → fixed: a `reconnected` answer is adoptable only by the
    owner of its row, decided before any write, and the reservation is confirmed after the
    upsert. Live: U2 start while U1 records → 409 `Recorder is busy with another recording` and
    U1's session keeps running.
  - `R4-002`/`R3-001` (the recorder buffered the whole capture before the web cap applied) →
    fixed: the size is stat-ed first (`MAX_CAPTURE_BYTES`, 32 MiB) and an oversized file answers
    413 without being read.
  - `R4-003`/`R4-004`/`R3-005` (an unusable capture left the row `recording` and the file on the
    volume, retried forever) → fixed: oversized and partial captures move the row to `failed`
    and release the file. Live: partial capture → `persisted:false`, row `failed`, file released.
  - `R1-002`/`R3-002`/`R2-003`/`R2-004`/`R3-004`/`R3-006`/`R2-001`/`R2-002` → fixed: null stop body,
    malformed 2xx parsed as such, viewport preserved across the stop, a refused stop looks for a
    row a retry saved, the poll flag resets on a new recording, and review links only provenance
    it loaded.
  - `R1-003`/`R4-001`/`R2-005` (raised ceilings in `deploy/.env.example`) → still the owner's
    call; flagged by all five rounds.
  Live after rebuilding: busy refusal, normal stop persisted, partial capture terminal.
