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

## Tasks

- T1 — Recorder: await the capture flush, return the stopped id/event count/duration from
  `/stop`, answer `idle` honestly, and serve `GET /captures/:id` with id validation. Route:
  inline. Commit: see Log.
- T2 — Web API: `/api/recorder/stop` persists the capture into `recordings` and reports what
  it saved; `GET /api/recordings/[id]` serves the capture; `POST /api/recordings` links the
  scenario to its recording. Route: inline. Commit: see Log.
- T3 — Recorder page: adopt the recorder's recording id, honest stop result with retry, and
  hand off to review with that id. Route: inline. Commit: see Log.
- T4 — Review page: load `?id=` capture automatically, keep the upload fallback, handle
  captures without steps, send the recording id when saving. Route: inline. Commit: see Log.
- T5 — Recordings list: read the fields the API really returns (`startUrl`, `state`) and open
  review by id. Route: inline. Commit: see Log.
- T6 — Deploy: give the web container the recorder token and keep captures on a volume so a
  recorder restart does not lose them. Route: inline. Commit: see Log.
- T7 — Checks: typecheck, recorder integration tests, web unit tests, live stop→save run.
  Route: inline. Commit: see Log.

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
