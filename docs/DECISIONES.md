# Foundation decisions

## Phase 4 — editor core mapping (K6F4-05a)

Pure data transformation between React Flow nodes/edges and `GraphDraftComposition`.
No React, no side effects — just functions for the editor (05b) to consume.

| Decision | Rationale / consequence |
|----------|-------------------------|
| `@xyflow/react` added as dependency | React Flow library for visual node editor, pre-approved in init §2.1. |
| `K6NodeData` interface with index signature | Required by `@xyflow/react` `Node<T>` constraint (`Record<string, unknown>`). |
| Type assertion in `fromReactFlowGraph` | The discriminated union requires exact literal types; caller validates with `graphDraftCompositionSchema`. |
| Simple left-to-right layout in `toReactFlowGraph` | BFS from root nodes, positions computed automatically. Editor (05b) may allow manual repositioning. |

Rollback: delete `apps/web/lib/editor/`, remove `@xyflow/react` from package.json.

## Phase 4 — scenario persistence (K6F4-04)

Scenario CRUD API under `/api/scenarios`, gated by session (any authenticated
user). Owner sees own scenarios, admin sees all. Graphs validated against
`graphDraftCompositionSchema` from `@k6flow/shared`. Pure decision logic
lives in `api/scenarios/logic.ts` (unit-tested); DB-backed CRUD paths are
proven in the K6F4-06 real-stack e2e.

| Decision | Rationale / consequence |
|----------|-------------------------|
| `@k6flow/shared` added as dependency of `apps/web` | Phase 4 editor requires access to the Phase 1 graph contracts for validation. Human-approved 2026-10-03. |
| 401 vs 403 vs 404 distinction: no valid session → `401`; scenario not found → `404`; found but not owner and not admin → `403` | Clear status codes guide the UI. 404 before 403 ensures non-owners cannot probe existence (they get 404 for inaccessible or nonexistent). |
| Graph validation via `graphDraftCompositionSchema.safeParse()` returns 422 with flattened Zod errors | The schema is the single source of truth; 422 distinguishes graph-shape errors from missing-field 400s. |
| List endpoint returns metadata only (no full graph) | Performance: full graphs could be large; the editor fetches the full graph only when opening a scenario. |
| Ownership scoping: non-admin users see only their own scenarios | Multi-tenancy by default; admin override for support/debugging. |

Rollback: delete `apps/web/app/api/scenarios/**`, remove this section, and
remove `@k6flow/shared` from `apps/web/package.json` — no other surface
touched.

## Phase 4 — user management (K6F4-03)

Admin REST + admin UI for user accounts: list/create/delete/role-change
endpoints under `/api/users`, gated by the K6F4-02 session helpers, plus a
thin `/admin/users` page. Auth core (02a), auth API routes (02b),
middleware (02c), scenarios (K6F4-04) and the editor (K6F4-05) stay out of
this unit. Pure decision logic lives in `api/users/logic.ts` (unit-tested);
DB-backed insert/delete/update/list paths are proven in the K6F4-06
real-stack e2e.

| Decision | Rationale / consequence |
|----------|-------------------------|
| 401 vs 403 distinction: no valid session → `401 Unauthorized` (log in); valid session with role ≠ `admin` → `403 Forbidden` (do not retry with the same credentials); no further distinction (never echo roles or probe deeper) | The two statuses let the admin UI tell "log in first" from "you are not an admin"; both reveal nothing beyond the caller's own session state. DB failures inside `requireUser` are a generic `500`, never 401/403, so an outage cannot masquerade as an auth problem. |
| Password minimum `>= 12` characters, reused from the seed CLI (`apps/web/scripts/seed.ts` `validateSeedEnv`) as `MIN_PASSWORD_LENGTH` in `api/users/logic.ts` | One policy, one number — an admin-created account must never be weaker than the seeded admin; a future floor change updates both call sites together. Blank-check uses `trim`, length-check uses the raw string (passwords may contain intentional spaces; hashing uses the raw value). |
| Self-delete and self-demote guards: an admin must NOT delete their own account (`400`) or change their own role (`400`, any self-targeted change including a no-op) | Lockout prevention: a lone self-demote would leave zero admins and a self-delete removes the acting session's account. Both guards reject BEFORE any DB mutation; tests pin own-id → denied, other-id → allowed. |
| Duplicate username → `409` with a clear message, detected ONLY via the DB unique constraint (pg code `23505`) — no pre-check SELECT | The constraint is the single source of truth; no extra probe query means response timing cannot be used to enumerate usernames beyond what the constraint itself reveals. Any other insert failure stays a generic `500`. |
| Thin admin UI (`app/admin/users/page.tsx`, "use client"): state + `fetch` + render only, NO component test (K6F3-04 precedent: no testing library in the repo); inline styles matching `app/page.tsx`/`runs/[runId]/page.tsx`; the page never decides access itself — 401/403 from `GET /api/users` renders the forbidden branch | Security behavior stays server-side and unit-tested in `logic.ts`; the page only displays the API's `{ error }` messages and refreshes the list after successful create/delete/role-change. No login form — login is exercised via the API/seed. |

Rollback: delete `apps/web/app/api/users/**` and
`apps/web/app/admin/users/page.tsx`, remove this section, and nothing else
moves — no `lib/**`, no auth routes (02b), no `middleware.ts` (02c), no Go,
compose, or shared-package surface is touched by this unit; the users table,
scrypt helpers and seed CLI (K6F4-01) remain valid independent of it.

## Phase 4 — auth storage + wiring (K6F4-01b)

Own-credential auth storage for Phase 4: scrypt password hashing over
`node:crypto`, an explicit CLI admin seed, and the human-authorized web→db
compose wiring. Cookies/login handlers (K6F4-02) and the Drizzle
schema/migrations/client (K6F4-01a, commit `10bb888`) stay out of this unit.

| Decision | Rationale / consequence |
|----------|-------------------------|
| scrypt via `node:crypto` (no new hashing dependency): N=16384, r=8, p=1, keylen=64; per-user 16-byte `randomBytes` salt; stored as `scrypt$N$r$p$<salt-hex>$<hash-hex>`; `hashPassword`/`verifyPassword` are pure functions with no `getDb()` dependency; `verifyPassword` re-derives with the embedded salt/params and compares with `timingSafeEqual`; tampered/malformed stored strings return `false` (never throw) and embedded params are bounded (power-of-two N ≤ 65536, r ≤ 32, p ≤ 16, N·r ≤ 262144) so a tampered hash cannot DoS verification; blank passwords rejected (`hashPassword` throws, `verifyPassword` returns `false`) | Human-approved decision: own-credential auth, scrypt via `node:crypto`, roles `admin` + `user`. Sync `scryptSync` chosen because the contract signatures are synchronous (`string`/`boolean`); N=16384 costs ~50–100 ms per call — acceptable for the seed CLI and login-frequency K6F4-02 handlers; an async twin can be added later without changing the stored format. Constant-time compare closes timing side channels on the stored hash. |
| DB-backed opaque session tokens in the `sessions` table — NOT stateless JWT | Revocable by row deletion, no signing key to rotate or leak, consistent with the already-migrated `sessions` schema; token/cookie mechanics are K6F4-02. |
| Explicit CLI admin seed (`pnpm --filter @k6flow/web seed`, `apps/web/scripts/seed.ts`) reading `ADMIN_USERNAME` + `ADMIN_PASSWORD` from env — NOT auto-seeded on web boot | init §10 secrets-via-env: boot must not create privileged accounts implicitly; the CLI upserts by username (existing → update `passwordHash` + `role='admin'`), prints only username + role, exits non-zero naming any missing/short variable, and closes the cached pg pool so the process exits. |
| Seed CLI module loading: dynamic `.ts`-specifier imports plus a `registerHooks` resolve fallback registered only at the CLI entrypoint (plain Node ESM needs explicit `.ts` extensions; `apps/web/tsconfig.json` lacks `allowImportingTsExtensions`, tsc TS5097, and is outside this unit's edit surfaces) | Keeps `lib/db/client.ts` byte-identical to K6F4-01a and `pnpm typecheck` green; a later unit may add `allowImportingTsExtensions: true` and drop the hook. |
| web→db compose wiring: `DATABASE_URL: postgresql://${POSTGRES_USER:-k6flow}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-k6flow}` added to the production `web` service only — no `depends_on`, no new network; `deploy/docker-compose.dev.yml` untouched (compose merges environment maps; verified via `docker compose config` that the base `DATABASE_URL` survives the dev override); `.env.example` gains dummy `DATABASE_URL`/`ADMIN_USERNAME`/`ADMIN_PASSWORD` lines (existing `POSTGRES_PASSWORD` line untouched); Phase 0 production test amended (human authorization 2026-10-02) to allow `DATABASE_URL` on `web` while asserting the orchestrator stays strictly DB-free | Process health stays independent of the DB (`depends_on` remains `undefined` for both services; the `/api/healthz` probe assertions are unchanged); the orchestrator keeps Phase 0's DB-free invariant. |

Rollback: delete `apps/web/lib/db/password{,.test}.ts`,
`apps/web/scripts/seed{,.test}.ts`, the `seed` script line in
`apps/web/package.json`, the `DATABASE_URL` lines + authorization comment in
`deploy/docker-compose.yml`, the appended dummy lines in `deploy/.env.example`,
restore the original blanket DATABASE_URL-absence assertion in
`tests/phase-0-compose.test.ts`, and remove this section; `lib/db/{schema,client}.ts`,
migrations, `drizzle.config.ts`, `apps/web/app/**`, `packages/**`, all Go
surfaces, `deploy/docker-compose.dev.yml` and the existing `POSTGRES_PASSWORD`
line stay untouched.

## Phase 3 — minimal live-metrics dashboard (K6F3-04)

Route the browser's WebSocket through a Next rewrite, ship a thin
`/runs/[runId]` client shell over a dependency-free pure metrics lib, and
authorize the orchestrator's cross-origin handshake in the dev compose stack.
The orchestrator, shared contracts and `apps/web/package.json` stay untouched.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Rewrite `source: "/api/ws/:path*"` → `destination: (ORCHESTRATOR_WS_UPSTREAM ?? "http://orchestrator:8080") + "/ws/:path*"`; `output: "standalone"` unchanged | Contract-05 routing: the browser opens same-origin `ws(s)://<web-origin>/api/ws/runs/{id}` and Next proxies it to the orchestrator's internal `/ws/runs/{id}`; the orchestrator port is never exposed, so the browser never dials the Go service directly. `ORCHESTRATOR_WS_UPSTREAM` lets the dev compose `web` service name the upstream across the Docker network; the default keeps bare `next dev` working with no env set. |
| `ORCHESTRATOR_ALLOWED_ORIGINS: ${WEB_ORIGIN:-http://127.0.0.1:3000}` added to the dev orchestrator — human-authorized 2026-10-02, the ONLY change under `deploy/**` | Behind the proxy the handshake `Origin` is the web origin, which differs from the orchestrator `Host`, so the K6F3-02 same-origin default would 403 the dashboard (K6F3-03 decision). Dev only: `.env.example` and every other `deploy/**` path remain untouched. |
| Hand-rolled validation of the 10 contract fields in `apps/web/lib/live-metrics.ts`, ZERO new dependencies — `@k6flow/shared` is NOT imported | Human-approved decision: `apps/web/package.json` and `pnpm-lock.yaml` stay byte-identical and the browser bundle gains no zod. Parity is textual, not import-level: the validator mirrors `packages/shared/src/metrics-messages.ts` (`metricsFrameSchema`) 1:1 — `version===1`, `type==="metrics"`, nonblank runId, nonnegative safe-int `seq`, `window.durationMs===1000`, nonnegative safe-int `startMs`, finite nonnegative sample numbers (failure fraction within [0,1]) with the sample-derived trio null EXACTLY together — and `live-metrics.test.ts` pins the duplicated contract key list against the exported `METRICS_FRAME_KEYS`, so drift on either side fails the suite. |
| Strict frame object: unknown or missing keys rejected at every level (top level, `window`, `latencyMs`) | Textual mirror of `z.strictObject`; decided here because the hand-rolled validator owns the contract surface in the browser. |
| Thin `"use client"` shell; NO component test | No testing library exists in the repo (adding one would be a new dependency, out of scope); every behavior is delegated to `lib/live-metrics`, which is fully unit-tested, so the component only holds state and renders — kept thin to minimize review weight. |
| Reconnect semantics: manual Connect/Disconnect only — no auto-reconnect and no replay; each connect resets the local window list | Implements Phase 3 policy 4 scope and keeps the contract deferral explicit: replay, terminal frames and automatic recovery stay deferred capabilities; a reconnect simply observes fresh frames from the next window. |
| Close-code mapping: server close `1000` → status "run finished"; any other close → "closed"; the client closes with code `4000` (application range) for disconnect/reconnect/unmount | Distinguishes the clean terminal close(1000) from error closes (e.g. 1006) and from user-initiated teardown, so 1000 stays reserved as the server's run-finished signal. |
| Formatters: null → `—`; failure fraction → percent with one decimal (`toFixed(1)` of `fraction×100`); latencies fixed integer ms; req/s one decimal | Explicit nulls render as an em dash, never a silent 0 (contract nullability), and rounding is fixed and documented instead of locale-dependent. |

Rollback: delete `apps/web/lib/live-metrics{,.test}.ts`,
`apps/web/next.config.test.ts`, `apps/web/app/runs/`, the `rewrites()` block
in `apps/web/next.config.ts`, the four added lines in
`deploy/docker-compose.dev.yml` and this section; `apps/web/package.json`,
`pnpm-lock.yaml`, `packages/**`, `docs/api/**` and all Go surfaces stay
untouched.

## Phase 3 — engine→hub wiring + real-Docker proof (K6F3-03)

Wire the K6F3-01 tap's window frames to the K6F3-02 hub, close a run's
subscribers when the run terminalizes, mount `GET /ws/runs/{runId}` beside
the REST API in `cmd/server`, and prove the full path against the real
Docker daemon with a real WebSocket client. The Next proxy rewrite and the
dashboard page (K6F3-04) stay out of this unit.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Wiring diagram: engine tap → `engine.Deps.Sink` = `&sinkAdapter{hub: ws}` → `live.New(Deps{Token: cfg.ServiceToken, Lookup: store, Logger, AllowedOrigins})` → per-run hub → subscribers; terminal run → `sinkAdapter.OnRunFinished(runID)` → `hub.CloseRun(runID, 1000)`; process shutdown → `srv.Shutdown` then `ws.CloseAll(1000)` | One root mux (`newRootHandler`) serves `/` (the contract-04 handler — `/healthz` and `/api/*` byte-identical to before) and `/ws/runs/` (the live endpoint's own mux, so the K6F3-02 gate order 404-blank → 401 → 404-unknown → 405 → upgrade is preserved). The bare `/ws/runs` path canonical-redirects (307) into the registered subtree and can never reach the upgrade. `CloseAll` runs on shutdown because hijacked WebSocket connections are invisible to `http.Server.Shutdown` — subscribers get a clean 1000 instead of dying with the process. |
| `engine.RunFinisher { OnRunFinished(runID) }` — an OPTIONAL extension of the injected sink contract, defined in `internal/engine` (frozen `internal/metrics` and `internal/live` untouched) and detected by type assertion: nil sink or a `metrics.FrameSink`-only sink is a no-op | The terminal signal needs no interface change anywhere frozen: `live.Server` already exposes `CloseRun(runID, code)`, and the `cmd/server`-local `sinkAdapter` (compile-asserted against both `metrics.FrameSink` and `engine.RunFinisher`) translates `OnRunFinished` → `CloseRun(runID, 1000)`. The adapter exists ONLY for that signature mismatch — `OnFrame` is a verbatim passthrough, since the hub already implements `metrics.FrameSink`. |
| `OnRunFinished` ordering guarantee (asserted deterministically by hook, no sleeps): it fires exactly once per run that terminalizes while the engine holds its handle, AFTER the tap is joined (`t.wait()` ⇒ every `OnFrame` for every closed window already completed; the trailing partial window never emits per K6F3-01, so no application frame can follow the notification) and AFTER the terminal `SetStatus` + `SetSummary` are persisted, but BEFORE the deferred Cleanup (`Stop→Remove`), semaphore release and handle deregistration | Every terminal path passes the notify point: finished (exit 0/99), failed (crash exit, wait error, parse error), stopped, the `failLaunch` create/start failures (no completion goroutine exists there, so duplication is impossible), and the rejected-final-transition edge (store already terminal ⇒ still exactly once). Early rejections that change no status (unknown run, canceled context, exhausted semaphore, double launch, Stop on unknown/unlaunched) never notify — a subsequent successful completion still notifies exactly once. A slow or failing container removal can therefore neither delay nor skip the subscriber close. Ordering vs. the write side: frames are only queued into the subscriber buffer at `OnFrame` time; delivery of an already-queued frame versus the close control frame is the pre-existing, accepted `R3-close-order` advisory on the frozen live side — in the real E2E the last window frame lands ≥1 s before terminal close, so nothing races. |
| Notification isolation: `notifyRunFinished` wraps the call in the tap's recover policy (K6F3-01) — a panicking hub logs `run-finished notification panic recovered; run unaffected` and can never abort completion, cleanup, semaphore release or deregistration | A broken subscriber path must not take down the run machinery; the same policy as per-line `OnFrame` calls, proven by test on both sides. |
| `ORCHESTRATOR_ALLOWED_ORIGINS` read `main.go-local` (same pattern as `ORCHESTRATOR_NETWORK`; `config.Config` stays frozen): empty/whitespace ⇒ `nil` ⇒ live keeps its default same-origin `CheckOrigin`; otherwise a comma-separated list, entries trimmed; **fail-closed startup error** on any malformed non-empty value — each entry must be an absolute `http(s)` origin with a host and no path/query/fragment, and empty entries (stray commas) are errors. No coercion, no silently dropped entries | Consistent with `config.Load`'s strictness: a partial allowlist would 403 the production proxy and a coerced one would weaken the origin gate; failing at startup surfaces the mistake before any socket opens. K6F3-04 MUST set it: in compose the browser's `Origin` header is the WEB origin (Next.js), which differs from the orchestrator host behind the proxy, so the same-origin default would reject the dashboard's handshake with 403 until the rewrite lands and the value is configured. |
| Integration proof (`//go:build integration`): `GOCACHE="$PWD/node_modules/.go-cache" GOMODCACHE="$PWD/node_modules/.go-mod-cache" go test -tags integration -count=1 ./internal/engine/ -v` — NEW: `TestRealRunStreamsMetricsOverWebSocket` (real REST 202 → real k6 run, 1 VU/4 s, subprotocol dial while live, ≥2 frames each validated against the Phase 1 contract: exact field set, version 1, type `metrics`, `durationMs` 1000, `startMs = seq·1000`, monotonic gapless `seq`, null-exactly-together sample trio, `reqPerSec > 0` + latencies ≥ 0 on traffic windows → then close **1000 with empty reason** and no frame after the last window → `ListLabeled` empty) and `TestWebSocketHandshakeRejects` (wrong token → 401, missing token → 401, unknown run → 404, all over a real loopback socket, pre-upgrade) | Suite observed: 47 tests, 0 skips, ~19 s (≪ 4 min budget). Skip policy unchanged — skip ONLY on Docker-connection errors, explicitly reported; the handshake negatives need no Docker and never skip; `t.Cleanup` force-removes labeled containers on failure; scripts stay ≤5 s/1 VU. Observed E2E transcript: `received 4 frame(s) (traffic windows 4), then close 1000 reason ""`. |
| Known boundary + deferrals: a stop on a PENDING, never-launched run is terminalized inside frozen `internal/httpapi` — the engine never holds the handle, so no `OnRunFinished` fires and such subscribers close only via shutdown `CloseAll` (the engine-notify contract covers runs it launched or began launching); the Next proxy rewrite `/api/ws/runs/:id`, the `/runs/[runId]` dashboard and the production `ORCHESTRATOR_ALLOWED_ORIGINS` value are K6F3-04; terminal frames, replay and partial-window flush remain deferred capabilities | Documented rather than fixed: reaching into `httpapi` (frozen) or inventing a store-level terminal hook would exceed this unit's edit surfaces; subscribers to a pending run are a minutes-long, pre-launch window. |

Rollback: remove the K6F3-03 lines from `cmd/server/{main,main_test}.go`,
the `RunFinisher`/`notifyRunFinished` additions plus their tests from
`internal/engine/{engine,engine_test}.go`, the K6F3-03 block appended to
`internal/engine/integration_test.go` and this section; `internal/live`,
`internal/metrics`, `internal/httpapi`, `internal/config`, go.mod/go.sum and
all other packages stay untouched.

## Phase 3 — metrics WebSocket endpoint (K6F3-02)

Serve `GET /ws/runs/{runId}` from the orchestrator with gorilla/websocket:
subprotocol-token handshake auth, a per-run subscriber hub implementing
`metrics.FrameSink`, and the approved 64-frame drop-oldest backpressure.
Engine wiring (K6F3-03), the Next proxy (K6F3-04) and terminal/replay frames
stay out of this unit.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Dependency: `github.com/gorilla/websocket v1.5.3` (human-approved library), no transitive requirements | Go-floor proof: the module's `go.mod` declares `go 1.12`, confirmed two ways — `go list -m -json github.com/gorilla/websocket` → `"GoVersion": "1.12"` and the cached `v1.5.3.mod` — well under the module's `go 1.25.0` directive; a `go list -m -f '{{.Path}} {{.Version}} {{.GoVersion}}' all` sweep reports **0 modules above 1.25.0**; `go mod tidy -diff` clean. go.mod delta: one `require` line; go.sum: the two standard gorilla hashes. |
| Handshake auth via `Sec-WebSocket-Protocol` (approved policy 2): the client offers the comma list `k6flow.bearer, <token>` — browser: `new WebSocket(url, ["k6flow.bearer", token])`; Go dialer: `d.Subprotocols = []string{"k6flow.bearer", token}`. Accept iff the scheme `k6flow.bearer` is present AND some offered value constant-time-matches (`subtle.ConstantTimeCompare`) the configured `ServiceToken`; extra offered values are ignored; an empty configured token fails closed. Rejections answer **401** with the contract JSON error envelope (`{"version":1,"code":"unauthorized",…}`) **before** the upgrade (no `Sec-WebSocket-*` headers). On success the server negotiates exactly one subprotocol and echoes `Sec-WebSocket-Protocol: k6flow.bearer` (gorilla `Upgrader.Subprotocols`). Auth runs **before** the run-existence lookup, so an unauthenticated client cannot probe which runIds exist. Vectors pinned by test: no header, only-scheme, only-token, wrong token, wrong scheme (`bearer`), empty configured token, extra offered values, bad-auth + unknown run → 401 (order). | Browsers cannot set `Authorization` on a WS handshake and the token must never appear in URLs/logs (init:111 service-auth consistency). Constant time keeps token comparison free of timing shortcuts; fail-closed mirrors `config.Load`'s empty-`SERVICE_TOKEN` policy. |
| Origin policy: default = same-origin — the `Origin` host must equal the request `Host` (case-insensitive host compare; scheme ignored so a TLS-terminating proxy still matches); a **missing** `Origin` is allowed because only non-browser clients omit it (browsers always send it on a WS handshake); an explicit `Deps.AllowedOrigins` list **replaces** the default (exact case-insensitive match of the full origin). Rejected origins fail the upgrade with HTTP 403 (gorilla, pre-handshake). | Behind the K6F3-04 Next proxy the browser `Origin` is the web origin, which differs from the orchestrator's `Host`; the allowlist exists so that wiring can grant exactly `http(s)://<web-origin>` without weakening the default. Default tests: same-origin, absent, cross-origin, `null` origin; allowlist tests: match, same-origin-but-unlisted (403 — replacement, not extension), absent. |
| Hub: mutex-guarded `map[runID] → set of subscribers`; `OnFrame(metrics.MetricsFrame)` (implemented by both the hub and `*live.Server`, so the engine tap can inject either) encodes the frame **once** (`EncodeJSON`) and fans out with **non-blocking** sends into each subscriber's 64-frame channel; when full it drains the oldest frame and retries — **drop-oldest, newest always lands**, `seq` stays monotonic with allowed gaps (contract: gaps legal, ordering is a producer obligation). The hub lock is held only across channel operations — `OnFrame` performs no socket I/O and can never block. | Implements approved policy 3 and answers the K6F3-01 native advisory **`R3-blocking-sink-stalls-completion`**: a stalled dashboard client must not stall the engine tap that calls `OnFrame`. Proven by test: with a subscriber whose channel nobody drains, 200 `OnFrame` calls finish within a bounded timeout (fail = timeout, not sleep-sync), the buffer holds exactly frames 136…199 (latest preserved), and a live client still receives the newest frame beside the stalled one. |
| Single writer per connection: one goroutine drains the channel and writes `TextMessage` frames; control frames (close) use gorilla's `WriteControl`, documented concurrency-safe and deadline-bounded. After the server sends a close frame gorilla fails every later write with `ErrCloseSent`, so no data frame can follow a close. | Frames can never interleave or tear (ordering proven by burst tests and by `CloseRun` racing a 2000-frame burst under `-race`). |
| Close semantics: `CloseRun(runID, code)` (callers pass **1000**) detaches and prunes the run's registry entry synchronously, then sends a close frame with **empty reason and NO terminal frame** (terminal frames remain a deferred capability); the reader gets a bounded deadline so a peer that never echoes the close cannot leak the pump. `CloseAll(code)` does the same for every run (server shutdown, wired in K6F3-03). A frame-write failure unregisters first, then drops the connection with a best-effort close **1011** and empty reason. Client-initiated close: gorilla's default handler echoes, the read error unregisters and the handler closes the socket. | Registry cleanup is observable (`run` key pruned when its last subscriber leaves) and asserted for `CloseRun`, `CloseAll`, write failure and client close. 1000/empty-reason is the parent-decided terminal close of the connection lifecycle; 1011 marks server-side write errors per RFC 6455. |
| Read side: the client is **receive-only** — inbound application messages are discarded under a 1 KiB `SetReadLimit`; ping/pong and the close handshake are answered by gorilla's default handlers; any read error tears the subscriber down. | No client input is parsed, so the attack surface is one bounded discard loop; the documented policy keeps the dashboard protocol strictly one-directional until a future input capability is designed. |
| Path gate: `http.ServeMux` pattern `GET /ws/runs/{runId}` (Go 1.22 patterns; module directive 1.25.0). Order: blank/nested runId → **404** (mux, pre-upgrade) → auth → **401** → unknown run via the local `RunLookup` interface (satisfied by `*runs.Store`) → **404** JSON envelope → upgrade. Non-GET → 405 (mux). | The exact-pattern mux gives blank/nested/method rejection without hand-rolled parsing; every rejection happens before any upgrade, and the test suite pins each status. |
| Deferred: engine → hub wiring and `CloseRun` on terminal state (K6F3-03); Next proxy rewrite `/api/ws/runs/:id` (K6F3-04); production `AllowedOrigins` value chosen at wiring; terminal frames, reconnect replay and partial-window flush stay deferred capabilities | K6F3-02 ships the endpoint and hub as an injectable unit: `live.New(Deps)` + `Handler()` + `OnFrame` are the surfaces 03 mounts; nothing outside `internal/live`, go.mod/go.sum and this section changed. |

Rollback: remove `internal/live`, the gorilla lines from `go.mod`/`go.sum`
and this section; `internal/metrics`, `internal/engine`, `internal/httpapi`,
the store, config, runtime, `cmd/server` and `docs/api/**` stay untouched.

## Phase 3 — streaming window aggregator (K6F3-01)

Parse the k6 JSON-LINES stream incrementally, aggregate fixed 1-second
run-relative windows into Phase 1 contract frames (`internal/metrics`) and
restructure the engine's `Output()` consumption around a single-consumer tap
(`io.Pipe` → frozen `k6sum`). Hub/broadcast (K6F3-02), production wiring
(K6F3-03) and the dashboard (K6F3-04) stay out of this unit.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Window anchor/time source: the anchor is sampled when the tap attaches `Output()` (once, right after the container starts; injectable clock seam `Deps.Now`, default `time.Now` — monotonic reading), and k6 point times (`data.time`, RFC3339Nano) map to run-relative offsets `pointTime − anchor`; window `n` = `[n·1000, (n+1)·1000)` ms | Run-relative `window.startMs` resets per run (contract §window). Anchoring at tap attach keeps windows monotonic and test-deterministic without reading the container's clock. Fallbacks: a point **without a usable time** falls back to **arrival time** (`now − anchor`) — accurate only while the stream is read live, because a buffered/post-run read compresses arrivals toward the anchor (documented accuracy caveat); points stamped **before the anchor** (k6 may emit before the tap attaches; container clock skew) clamp into window 0, so negatives can never mint windows before run start; points more than **1 h ahead** of the anchor are treated as clock-corrupt and also use arrival time, so a bogus year-9999 stamp cannot fan out billions of empty frames (anti-flood guard). |
| Per-window, never cumulative: `reqPerSec` = window `http_reqs` point count / 1.0 s; latencies from that window's `http_req_duration` samples only; `httpFailureFraction` = window `http_req_failed` 0/1-sum / window request count (∈ [0,1], clamped, rounded to 3 decimals); `failedChecks` = window count of `checks`/`check` value-0 points; `activeVUs` = last `vus` value carried into the window (gauge, clamped to the safe-integer range) | Matches the Phase 1 schema exactly: a frame never carries cumulative totals or `thresholdsPassed`. `http_reqs` is counted **per point** (one k6 counter point per request) — the same semantics k6sum uses. Sample trio (`reqPerSec` + four latencies + `httpFailureFraction`) is non-null **iff** the window had `http_reqs` points and is nulled exactly together (stray duration/failure samples in a request-less window are dropped from the frame); `failedChecks`/`activeVUs` are plain ints — never null, `0` meaningful; `activeVUs` starts at 0 before any `vus` point. A window with requests but zero duration samples (unreachable with real k6, which pairs one duration point per request) yields zero latencies so the refine (trio null exactly together) still holds. |
| Empty-window emission: frames are emitted **only on rollover** — every window that closes while the stream is active emits exactly one frame (all-null sample trio included; `activeVUs`/`failedChecks` stay meaningful), a gap between observed points emits its intermediate empty windows, `seq` starts 0 and is +1 per emitted window (gapless by construction), and the **trailing partial window never emits** (no end-of-stream flush); once the stream ends (run terminal) the feed stops, so no post-terminal frames exist | The contract implies empty windows must emit: it requires a null trio *on* no-request windows, so such windows carry frames. Rollover-driven emission makes `seq` monotonic and window-complete for every subscriber (a frame is only visible once its window closed). The trailing partial window is not a completed 1000 ms window; flushing it would publish a partial span under a fixed-duration declaration — deferred with the replay/terminal-frame capabilities. |
| Latency math: **replicated** from the frozen `k6sum` (`percentile` nearest-rank ceil(p/100·n) no-interpolation, `round3` half-away-from-zero 3 decimals, avg over sorted samples) rather than reused — k6sum's helpers are unexported and the package is frozen — plus a nonneg clamp for the contract range; a parity test feeds identical lines through `k6sum.Parse` and the aggregator and requires bit-identical avg/p90/p95/p99 (and matching requests/failed-checks totals) | Window frames and the final summary can never disagree. The Phase 1 schema enforces ranges, not rounding; 3 decimals (0.001 ms) keeps the Phase 2 summary choice for consistency and deterministic serialization. `round3` also normalizes `httpFailureFraction` (e.g. 1/3 → 0.333). |
| Sink interface + isolation: `metrics.FrameSink { OnFrame(MetricsFrame) }` is injected (nil = no sink; engine `Deps.Sink`, production wiring in K6F3-03) and called synchronously on the tap's single goroutine; **isolation policy = recover**: the tap wraps each line's aggregation+sink call with a `recover` that logs `metrics aggregation panic recovered; run unaffected` and continues — aggregator/sink failures are logged and skipped and can never fail or corrupt the run | A broken subscriber (panic) must not take down the run or the summary — the broadcast path is best-effort. Contrast k6sum's fail-the-summary policy (frozen, unchanged): the same malformed input that aborts a summary is skipped by the aggregator. Both policies coexist because the tap keeps the two paths independent. |
| Tap/pipe design: `Output()` is attached exactly once per run (single consumer) at launch; the pump forwards **raw bytes untouched** to `k6sum.Parse` through an `io.Pipe` (no full-stream buffer, no re-encoding) and feeds complete lines to the aggregator on the same goroutine; `k6sum.Parse` drains the pipe concurrently, and `PipeReader.CloseWithError(err)` after an early parse abort fails any pending write so the pump can never deadlock; `complete()` joins the tap after `Wait` (force-closing the log stream on a wait error) and only then decides | Byte-compatibility: k6sum observes the identical byte stream (same lines, same read errors wrapped in its own `k6sum: read stream`/oversized messages), so exit-code mapping, Stop precedence, parse-error → failed, stopped-run zero-summary fallback, guaranteed cleanup and semaphore release behave exactly as before — the summary tests are unchanged except the documented `Output`-before-`Wait` call-order assertions. Live frames start while the run runs (attach before `Wait`), which the pre-tap flow (read after `Wait`) could not provide. Memory bounds: 32 KiB read buffer + a line accumulator capped at `k6sum.MaxLineBytes` (1 MiB; overlong lines are dropped from aggregation only, raw bytes still reach k6sum) + one window's samples (discarded on frame emission; the VU gauge and seq are O(1)). |
| Malformed-line divergence: on the broadcast path a malformed JSON line, undecodable point (non-string metric / non-numeric value), unknown message type or metric, late out-of-order point, blank line and oversized (> 1 MiB) line are **ignored defensively** and the stream continues; k6sum keeps its fail-the-summary abort | Deliberate and documented: skipping could silently understate a summary (untrustworthy, so k6sum aborts), while skipping a broadcast frame merely smooths a live dashboard — and killing a run because a dashboard line was ugly is unacceptable. Oversized handling aligns at the same 1 MiB bound (`k6sum.MaxLineBytes`); no unbounded memory exists on either path. |
| Deferred: WS hub, subscriber fan-out and 64-frame drop-oldest backpressure (K6F3-02); `Deps.Sink` production wiring, real-Docker end-to-end proof and hub lifecycle (K6F3-03); `/runs/[runId]` dashboard (K6F3-04); terminal frames, replay and partial-window flush | K6F3-01 ships the aggregator as a pure, hub-agnostic unit: `RunWindowAggregator` + `FrameSink` are the contract surface the hub will subscribe to; the engine takes a nil sink today (all existing tests construct `Deps` without one). |

Rollback: remove `internal/metrics`, the tap additions in `internal/engine`
(`startTap`/`pump`/`feedLines`/`forwardLine`, `Deps.Sink`/`Deps.Now`) and
this section; `internal/k6sum`, the store, runtime, httpapi, config and
`cmd/server` stay untouched.

## Phase 2 — full wiring + real-Docker proof (K6F2-05)

Wire the whole stack (REST handler → engine → Docker) in `cmd/server`, expose
it to curl (init:184), and prove every lifecycle path against the host engine
with `//go:build integration` tests.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Async 202: `startRun` writes the response first, then runs `go launcher.Launch(context.WithoutCancel(r.Context()), runID)` | True acceptance semantics; the request context dies with the response, so the launch gets a detached one. A Launch error after the 202 is logged only — terminalizing the run is the engine's own failure path (`failLaunch` ⇒ failed). The run leaves the store as `pending`; the engine promotes it to `running` (the K6F2-02 synchronous placeholder is gone). |
| Local `RunLauncher { Launch, Stop }` interface defined in `httpapi`, implemented by `*engine.Engine` in cmd/server | The HTTP layer never imports the engine package; unit tests keep a deterministic fake (gated launch proves the 202 precedes launch completion). `Deps.Runtime` (ContainerRuntime) is gone — the handler never touches containers. |
| Stop finalization ownership: handler always calls `launcher.Stop` for non-terminal runs, but only terminalizes runs still `pending` itself; a `running` run is finalized by the engine's completion goroutine | Lets the engine persist the stopped-run summary (handler-side terminalization would make the engine's final `SetStatus` hit terminal immutability and drop `SetSummary`). 202/404 semantics unchanged; a failed engine stop is logged and still 202 (the completion path converges later). |
| `thresholdsPassed` omitted for non-`finished` summaries | K6F2-04 verifier finding #4 — `runSummarySchema` carries it only for `finished`. Verified (tests + curl e2e), no code change needed: `handlers.go` already gated on `finished`. |
| Startup `ReconcileOrphans` before serving, failure ⇒ log + continue | Docker-down boot still serves REST (launches then fail per run). Success logs the removed count (`removed=0` observed in every integration run). |
| Graceful shutdown: SIGINT/SIGTERM → `http.Server.Shutdown` (10s) | HTTP drains only; in-flight run containers stay labeled and are left for the next startup's reconciliation. Deeper drain/kill on shutdown is Phase 9 (recorded per unit spec). |
| `ORCHESTRATOR_NETWORK` read directly in `cmd/server` (not `config.Config`, which stays frozen) and applied by the decorator: empty ⇒ engine default | `config.Config`/`engine`/`runtime/docker.go` cannot accept a network field in this unit; the decorator fills `Spec.Network` only when the spec has none (an explicit engine-provided network wins). |
| `decoratedRuntime` in `cmd/server` wraps `*DockerRuntime` for two stream/spec fix-ups the frozen files cannot host | (1) injects k6 `--quiet` into `Spec.Args`: k6 v2.3 writes progress to STDOUT, interleaving **mid-line** with the JSON points and corrupting them (observed: `unexpected end of JSON input`); `--quiet` removes progress and the banner. (2) `Output` runs `stdcopy.StdCopy` (Docker's 8-byte multiplex framing on non-TTY logs — proven on the raw Engine API: header `01 00 00 00 …` per frame) and then keeps only `'{`-opening lines: the end-of-run summary still prints on stdout after the last point and is dropped at that boundary. k6 stderr (banner/log lines that can echo script source) is discarded, never logged. |
| Docker SDK `client` import in `cmd/server` with pinned otel stack; final `go 1.25.0` | Unfrozen for this unit by human disposition (option 3). Untouched `go mod tidy` resolves otel v1.47.0 (go 1.26.0) and forces a directive the frozen `golang:1.25.7` image cannot build; pins keep every module floor ≤1.25: `otel v1.46.0`, `otel/trace+metric v1.46.0`, `otel/exporters/otlp/otlptrace{,/otlptracehttp} v1.46.0`, `otelhttp v0.71.0`, `x/sys v0.47.0`, `x/time v0.15.0` (MVS then settled `x/net v0.58.0`, `x/text v0.41.0`, `grpc v1.83.1`). `go mod tidy -diff` clean. |
| **Conformance (R3-k6-checks-name resolved): real grafana/k6 v2.3.0 emits the metric name `checks`, not `check`** | Recorded from real output: `{"type":"Metric","data":{"name":"checks","type":"rate",…},"metric":"checks"}` with `value:1` = passed, `value:0` = failed. `k6sum.MetricCheck` fixed to `"checks"` (value-0 semantics unchanged); the pre-conformance `check` spelling is kept as `MetricCheckLegacy` so the frozen K6F2-04 engine fixtures keep counting. `http_reqs`/`http_req_failed`/`http_req_duration` confirmed as assumed. |
| Integration suite: `GOCACHE=… GOMODCACHE=… go test -tags integration -count=1 ./internal/engine/ -v` | Real-Docker tests live behind the `integration` build tag (absent from `go test ./...`); skip **only** on daemon connection errors (explicitly reported), pull `grafana/k6` when absent, bounded scripts (≤5s, 1 VU, sleeping iterations — request storms measured at ~30 MB/s of JSON), `t.Cleanup` force-removes labeled leftovers. |
| curl evidence (init:184) against the real binary (`go build` + run, `SERVICE_TOKEN`/`ORCHESTRATOR_*` env) | Transcript (recorded in the unit report): `/healthz` → `200 {"status":"ok"}` public; POST `/api/runs` unauthenticated and wrong-Bearer → `401 unauthorized`; valid Bearer → `202 {version,runId}`; GET state polls `running` → `finished`; GET summary → `200 …"thresholdsPassed":true` with `totals{requests:3,errors:3,failedChecks:3}`; second run stopped → `202`, state `stopped`, summary `200` **without** `thresholdsPassed`; SIGINT → logged `shutdown signal received`, clean exit; zero `k6flow.managed` containers before and after. |

Rollback for this unit: `cmd/server/*`, `internal/httpapi/{server,handlers}.go`
(+ tests), `internal/engine/integration_test.go`, `internal/k6sum/{parse,parse_test}.go`,
go.mod/go.sum and this section — the frozen surfaces stay untouched.

## Phase 2 — k6 JSON output → approved summary (K6F2-04)

Parse the k6 `--out json` JSON-LINES stream into the approved contract-04
summary (`internal/k6sum`) and integrate it into run completion
(`internal/engine`: `Launch`/`Stop` over `ContainerRuntime`). Handler→engine
wiring and real-k6 conformance stay K6F2-05.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Metric names: `http_reqs` points → `totals.requests` count; `http_req_failed` 0/1 rate points → `totals.errors` = rounded sum; `check` points with value 0 → `totals.failedChecks`; `http_req_duration` trend points (ms) → latency samples | Exact aggregation contract, documented as assumptions taken from k6's builtin metric catalog and proven against the real `grafana/k6` image in K6F2-05. Metric descriptor lines (`{"type":"Metric"}`) carry metadata only; unknown metric names and unknown message types (`Summary`, `Group`, future additions) are ignored defensively. |
| Exit-code mapping: `0 → finished + thresholdsPassed=true`; `99 → finished + thresholdsPassed=false` (k6 threshold-failure exit); any other code → `failed`, no summary, no `thresholdsPassed` | k6 exits 99 when thresholds fail; other non-zero codes are crashes/engine failures, which contract 04 reserves for `failed`. Pure `k6sum.OutcomeForExit(code) (runs.Status, bool)` with a table test; `stopped` never comes from an exit code but from an explicit stop (precedence below). |
| Rounding: latencies to 3 decimals (0.001 ms, half away from zero); nearest-rank quantiles over the sorted samples (no interpolation); `errors` rounded to the nearest integer | `runLatencySchema` accepts finite nonnegative numbers (no integer constraint), so 3 decimals preserves sub-ms k6 samples while serializing deterministically. Nearest-rank only ever reports observed values — no invented latencies between samples. |
| All `http_req_duration` samples retained in memory for avg/p90/p95/p99 | Documented Phase 2 bound: memory is O(samples) (8 B per slice element plus amortized growth, ≈ 1 MB per ~130k samples), acceptable for runs bounded by `MAX_CONCURRENT_RUNS`/`MAX_VUS_PER_RUN` on the VPS. Streaming quantile aggregation is deferred to Phase 3 with WS metrics. |
| No-sample policy: all-zero totals and zero latencies — never null | `runSummarySchema` requires nonnegative integers for totals and finite nonnegative numbers for every latency field on every status; nulls would fail validation, zeros conform. `Parse` never sets `ThresholdsPassed` (the engine derives it from the exit code). Failed runs store no summary, so `GET /summary` answers 409 for them until contract 04 gains an explicit failed-summary rule. |
| Malformed-line policy: a non-JSON line, an undecodable Point (e.g. non-numeric value, missing `data`), or a line over 1 MiB (`MaxLineBytes`) aborts the whole parse with an error naming the line — fail the summary, never skip silently, never panic | Skipping corrupt lines could silently understate requests/errors and publish an untrustworthy “successful” summary; failing marks the run `failed`, which is visible. Blank/whitespace lines are skipped; non-object JSON (e.g. `null`) is ignored as an unknown message type. |
| Engine completion precedence: explicit stop → `stopped` (parses partial output; a parse failure there falls back to an all-zero summary, because a killed stream may truncate); else wait error / mapped failure / parse or output failure → `failed` with no summary; else `finished` with the parsed summary and exit-derived `ThresholdsPassed` | `SetStatus` (terminal) always precedes `SetSummary` (the store's terminal-only rule); terminal immutability is respected — a rejected final transition is logged and stores nothing. Stopped runs keep the terminal-summary invariant; crashed/failed runs carry none (409 above). |
| Guaranteed cleanup and release: every path after `Create` runs best-effort `Stop` → forced `Remove` on `context.WithoutCancel`, then `Semaphore.Release` and in-flight-handle deregistration (deferred, so they hold on success, parse failure, wait failure and cancellation alike); launch failures after the `pending→running` promotion terminalize the run as `failed`; early errors (unknown/terminal run, canceled context, exhausted semaphore) leave the status untouched | Removal and slot release cannot be skipped on any failure path. Double-launch is rejected by the in-flight handle map; `Stop` on an unknown id is an error, on a terminal or never-launched run a documented no-op (the store alone owns terminal transitions). |
| Spec: `run --out json --vus N --duration Nms /k6flow/script.js` with REST `vus`/`durationMs` overriding script options (contract 04), script delivered via the reserved `K6FLOW_SCRIPT` env key, `k6flow.run.id` label, image from `K6_IMAGE` config, contract CPU/memory limits | The script never appears in the spec args, labels or logs — `slog` lifecycle events carry only runId/container/exit-code/count metadata, asserted by test. |
| Handler→engine wiring and real-k6 conformance deferred to K6F2-05 | `httpapi/handlers.go` keeps its synchronous `pending→running` placeholder untouched (frozen surface); unit tests use `FakeRuntime` fixtures with no Docker, and K6F2-05 proves parser and lifecycle against the real engine and replaces the placeholder. |

Rollback: remove `internal/k6sum`, `internal/engine` and this section; the
store, runtime, httpapi, config and cmd/server packages stay untouched.

## Phase 2 — Docker runtime (K6F2-03)

Implement `ContainerRuntime` over the official Docker SDK in
`apps/orchestrator/internal/runtime/docker.go`, unit-tested against a fake
`dockerAPI` (no socket in tests); real-engine proof stays K6F2-05.

| Decision | Rationale / consequence |
|----------|-------------------------|
| `github.com/docker/docker` `v28.5.2+incompatible` + `go mod tidy` (6 indirect deps, 16 go.sum entries) | Latest SDK version on the module proxy (`+incompatible`: moby tags majors without a module suffix). Resolved with the authorized `GOCACHE`/`GOMODCACHE` under `node_modules/`. The module `go` line moves `1.22.0 → 1.23`, the true dependency floor (`docker/go-connections v0.8.1` requires go 1.23), still building under the frozen `golang:1.25.7` image. |
| Minimal unexported `dockerAPI` interface instead of embedding `*client.Client` | Unit tests fake exactly the 8 SDK calls used (create/start/wait/stop/remove/list/logs/copy) without touching a socket. Importing `github.com/docker/docker/client` for a compile-time conformance assert would pull its OpenTelemetry/x-sys tree and force `go ≥ 1.26.0`, which the frozen `golang:1.25.7` image (`GOTOOLCHAIN=local`) cannot build; the signatures are transcribed verbatim from client v28.5.2 source and conformance is proven by the real-engine unit (K6F2-05). |
| Script delivery: in-memory tar via `CopyToContainer` (no temp-file bind mount) | Secret hygiene: script bytes never touch the host filesystem, never enter logs (tests assert), and exist only at `/k6flow/script.js` inside the container until guaranteed removal. Because `Spec` (frozen `runtime.go`) has no script field, the content travels in the reserved `Spec.Env` key `K6FLOW_SCRIPT`, which `Create` strips before `ContainerCreate` — it never reaches the container environment. The run engine (later unit) sets `Env[ScriptEnvKey]` and args referencing `ScriptPath`. |
| Failed script delivery removes the half-created container | Guaranteed-removal holds from the first SDK call: `Create` returns a joined error after a forced `Remove` (with `context.WithoutCancel`) so a copy failure cannot strand an orphan. |
| Limits with overflow guards, not raw casts | `CPUMillis → NanoCPUs` (×1e6) and `MemoryMiB → bytes` (×2^20); values whose product overflows int64 — including contract 04's `2^53-1` ceiling — are rejected with a descriptive error instead of wrapping. Max valid: 9,223,372,036,854 cpu-millis, 8,796,093,022,207 MiB; boundary tests cover `cpuMillis=1`, both maxima and the rejections. |
| Controlled network via `Spec.Network → HostConfig.NetworkMode` | Per-run network selection belongs to the caller; empty means the engine default bridge for Phase 2. Binding the compose `backend` network name needs env/compose changes (parent-reviewed deploy surfaces) and is deferred. |
| Labels: `k6flow.managed=true` forced, `k6flow.run.id` passed through | `ListLabeled` filters `k6flow.managed=true` (All=true, so stopped containers count); `Create` overwrites any caller value for `managed`. The run-id label is supplied by the later engine unit via `Spec.Labels`. |
| Guaranteed cleanup: `Cleanup` = graceful `Stop` (RUN_TIMEOUT_MS rounded up to whole seconds; ≤0 leaves the engine's 10s) → `Remove(force)`, using `context.WithoutCancel` for the removal | Remove is always attempted — even when Stop fails or the run context is already canceled — and `Cleanup` never returns before that attempt; both errors are joined. Finish/fail/stop/cancel paths all funnel here. |
| Startup reconciliation: `ReconcileOrphans` = `ListLabeled` + force-remove each, returning the removed count | Documented to run at startup; list errors are returned, per-container removal failures are tolerated (warn + continue) so one stuck container cannot block the sweep. Call wiring into `cmd/server` is deferred to a later unit (cmd/server untouched here). |
| Exported `Semaphore` (context-aware `Acquire`, no-op `Release`, `n < 1` clamped to 1) sized by `MAX_CONCURRENT_RUNS`; `DockerRuntime.Acquire/Release` delegate | Non-blocking misuse impossible: a waiting acquire honors ctx cancellation, a double release can never deadlock the pool (`-race` concurrency test). Enforcement at the request handlers is deferred to a later unit. |
| `Output` returns the raw container log reader (stdout+stderr, follow) | Attachment point for the K6F2-04 JSON stream; the caller owns Close, and demultiplexing Docker's stream framing happens in the parser, not the runtime. |
| `slog` lifecycle events only (injected logger) | Logs carry container id, image, exit code and counts — never script or env values; a dedicated test asserts secrets and `K6FLOW_SCRIPT` stay out of the buffer. |

Deferred to later units: engine transition replacing the K6F2-02 synchronous
`pending→running` placeholder, startup wiring of `ReconcileOrphans`, handler
enforcement of the semaphore, network-name wiring, and real-Docker integration
tests (K6F2-05). Known pre-existing gap: `apps/orchestrator/Dockerfile` copies
only `go.mod` + `cmd` (no `internal/`, no `go.sum`), so the production image
build predates the Phase 1/2 package layout; fixing it touches a parent-review
surface and is reported rather than edited.

Rollback: remove `docker.go`, `docker_test.go`, the dependency blocks in
`go.mod`/`go.sum` and this section; the `ContainerRuntime` interface, the
`FakeRuntime` and every other package stay untouched.

## Phase 2 — runs REST handlers (K6F2-02)

Implement the approved contract 04 as `apps/orchestrator/internal/httpapi`
handlers over the Phase 1 store; container execution stays K6F2-03.

| Decision | Rationale / consequence |
|----------|-------------------------|
| `NewHandler(Deps) http.Handler` instead of `*http.Server` | Handlers stay directly `httptest`-verifiable; `cmd/server` (untouched by this unit) keeps server construction and timeout ownership for the later wiring unit. |
| Flat error envelope `{version, code, message}` | `runErrorResponseSchema` (`packages/shared/src/runs-rest.ts`) and `RunError` (`docs/api/openapi.yaml`) declare flat fields — not a nested `{"error":{...}}` object; messages mirror the OpenAPI response descriptions. |
| `400` with code `invalid-request` for malformed bodies | Phase 2 clarification: contract 04 declares only 401/404/409 for the runs routes and no malformed-body catalog code, but a rejected body must still answer with the structured envelope; mapping it onto `unauthorized`/`run-not-found`/`summary-not-terminal` would misstate the failure. `invalid-request` therefore sits outside the approved three-code enum until contract 04 is amended. |
| No `metadata` field on run start | `runStartConfigSchema` is a strict object (`version`, `script`, `vus`, `durationMs`, `cpuMillis`, `memoryMiB`, optional `attachments`) with `additionalProperties: false`; `metadata` and every other unknown field are rejected with 400. |
| Synchronous `pending → running` promotion after create | The engine is K6F2-03, so the handler stamps `running` before answering 202 to keep state/stop/summary observable and tests deterministic; a failed promotion is logged and the run stays accepted (still 202). K6F2-03 replaces this with the deferred engine transition. |
| Stop promotes `pending` before `stopped` | The store transition table allows only `pending → running` and `running → finished|failed|stopped`; a known non-terminal run therefore moves `pending → running → stopped` so stop always answers the idempotent 202. Terminal stops re-answer 202 without touching state. |
| Empty `SERVICE_TOKEN` fails closed | Per the `config.Load` contract, `NewHandler` with an empty token rejects every `/api/*` request with 401 — including a present but empty bearer value; constant-time comparison via `crypto/subtle`. |
| SHA-256 over the raw request bytes for dedupe | `Idempotency-Key` + payload hash index in `runs.Store`; an identical key and payload replays 200 with the existing runId, a different payload or an absent key always creates. |
| `log/slog` with an injected logger; secrets never logged | Tests capture handler output and assert the service token and script bytes are absent; only runId, method/path, status and validation errors are logged. |

Rollback: remove `apps/orchestrator/internal/httpapi` and this section; the Phase 1
store/runtime/config and `cmd/server` health probe remain untouched.

## Phase 1 — shared validation foundation (K6F1-01)

Use private `@k6flow/shared` for runtime validation and schema-inferred types.
It exports TypeScript source; no build artifacts or service runtime are introduced.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Zod 4.6.5, exact dependency pin | Human-approved validator supplies validation and inferred types from one schema. |
| TypeScript 5.9.3 | Reuses the web toolchain version; shared strict, no-emit checking runs through root lint, including shared tests. |
| Numeric literal `version: 1` | Minimal technical discriminator, without coercion or defaults; unsupported versions fail validation. |
| Strict `{ version: 1 }` foundation | Unknown fields fail; this is not a graph, REST or WebSocket payload. Future schemas must explicitly define their own fields. |
| Shared Vitest discovery | Adds shared tests while preserving web tests and the separate deployment-contract runner. |

### Dependency selection evidence

Read-only npm registry query on 2026-10-01:
`https://registry.npmjs.org/zod/latest` returned stable version `4.6.5`.
Tarball: `https://registry.npmjs.org/zod/-/zod-4.6.5.tgz`.
Registry integrity:
`sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==`.
This records the selection source, not an independent security assessment.

### Boundary and verification

Run `pnpm test`, `pnpm lint` and `git diff --check` from the root.
Web typechecking disables incremental output to keep validation read-only.
Runtime harness: N/A; validation adds no process or network boundary.
Rollback the shared package, workspace/test/typecheck wiring, lockfile changes
and these Phase 1 notes together; preserve all Phase 0 behavior and decisions.
Graph semantics, REST behavior and WebSocket routing remain outside this unit.

## Phase 1 — graph structure and reference invariants (K6F1-02)

Use separate draft-structure and execution-topology validators; neither establishes
full execution readiness. See [the graph contract](api/graph.md) for the shape.

| Decision | Rationale / consequence |
|----------|-------------------------|
| Strict version 1 structural objects | Required identified nodes, directed connections and explicit producer/output references; malformed fields, duplicate IDs/connections and dangling identities fail even in drafts. |
| Retain unfinished draft topology | Empty/disconnected drafts and references to existing self/later producers are storable; traversal constraints apply only at the execution-topology boundary. |
| One linear path per VU | Human-approved no-branch/no-cycle contract; iterative connection traversal rejects forks, merges and disconnected components without relying on array order. |
| Earlier-producer references | Execution topology requires producer rank before consumer rank; output strings are opaque names, not proof of output support. |
| Structural-only exports | `graphDraftStructureSchema` and `graphExecutionTopologySchema` explicitly avoid a broad executable schema; parameters, load and output semantics remain K6F1-03. |

Runtime harness: N/A; these pure validators introduce no process/network boundary.
Rollback only `packages/shared/src/graph.ts`, its tests and graph exports,
`docs/api/graph.md` and this decision section; preserve the foundation and tracking.

## Phase 1 — standalone values and HTTP parameters (K6F1-03a)

Use additive standalone schemas and inferred types; preserve graph behavior.
See [the HTTP wire contract](api/graph.md#standalone-http-parameters-k6f1-03a).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Human-selected whole literal/reference values | No interpolation or segments; references cannot add a URL path or token prefix. Expected string/JSON kind belongs to the consuming field, not an unchecked reference annotation. |
| Strict `kind` tags and nested `reference` identity | Engineering wire discriminators; reuse the graph identity schema without changing graph objects or claiming producer/output validation. |
| None, text and structured JSON bodies | Human-approved initial formats; JSON references replace the whole value. Nested reference-looking literal objects are data, not expressions. Forms/multipart/files remain deferred. |
| Finite plain JSON data | Reject executable/native values, cycles, accessors and lossy non-JSON properties; validation neither invokes getters nor performs interpolation. |
| Optional ordered header/query arrays and body | Preserve absence, duplicates and input order without defaults/transforms. Method accepts HTTP token syntax including extension methods; runtime encoding and method semantics are not implemented. |

K6F1-03f owns parameter/graph reference reconciliation and output compatibility
once producer contracts exist. This unit provides no auth/extraction/check/load
contracts, transport, URL security policy or execution-readiness guarantee.
Runtime harness: N/A; validation-only changes add no process/network boundary.
Rollback only standalone values/HTTP modules and tests, their additive exports,
the HTTP guide section and these decision notes; keep existing graph contracts.

## Phase 1 — target authentication and extraction declarations (K6F1-03b)

Use standalone `authParametersSchema` for scenario external-target login, not
K6Flow user authentication. See [the auth wire contract](api/graph.md#standalone-target-authentication-k6f1-03b).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Tagged HTTP-only method with reused request schema | Human-approved configurable request; preserve reviewed HTTP/value/graph behavior. No Basic Auth/OAuth2 variants or credentials in examples. |
| Unique required named outputs | Reuse graph output identity; nonempty outputs and explicit `required: true` avoid inventing optional-output behavior. Names compare exactly. |
| Structured JSON keys/indices or named header/cookie | No expression evaluator; token syntax validates selector names. Keys are data, including prototype-sensitive names; future resolution must use own JSON properties only. Empty path denotes the JSON root. |
| Explicit `string` / `json` expected category | Align with existing parameter consumers; JSON includes strings and null. Header/cookie declarations must be string; compatibility validation belongs to K6F1-03f. No serialization or coercion. |
| Literal `stop-current-vu-iteration` failure policy | Human-approved missing/type-failure outcome affects this iteration only, not other VUs. Validation declares it without implementing control flow. |

Optional outputs, repeated header/cookie matching, cookie ambiguity, invalid JSON,
transport/login failure handling and cookie persistence remain runtime decisions.
No token transformation, secret binding, extraction engine or graph composition.
Runtime harness: N/A; pure validation adds no process/network boundary.
Rollback only `auth-parameters.ts`, its tests, additive auth exports, the auth guide
section and these notes; preserve existing HTTP/value/graph contracts and tracking.

## Phase 1 — standalone structured response checks (K6F1-03c)

Use strict version 1 `checkParametersSchema` and inferred types independently of
reviewed graph/HTTP/value/auth contracts. See [the checks guide](api/graph.md#standalone-response-checks-k6f1-03c).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Explicit consuming response producer/output | Reuse structural identity; no implicit latest response or supported-output claim. K6F1-03f owns compatibility and precedence. |
| Unique named independent checks | Exact identities and stable duplicate issue paths preserve individual results; no runtime result envelope yet. |
| Structured numeric/text/JSON predicates | Human-approved comparisons only; finite numeric literals, literal text equality/inequality/containment and literal JSON equality data. No regex, code, interpolation or secret binding. |
| Reuse reviewed path segments | Root/key/index semantics match auth without modifying reviewed source; reference-looking JSON remains data. |
| Fixed record-failure-and-continue declaration | Failed checks, absent fields and incompatible actual types fail independently without aborting iteration; validation implements no check execution/control flow. |

Header matching/repetition, response ambiguity, runtime coercion, invalid response
JSON and transport behavior remain deferred. No response resolver or graph binding.
Runtime harness: N/A; validation-only declarations add no process/network boundary.
Rollback only check modules/tests, additive check exports, the checks guide section
and these notes (including its HTTP deferred-check wording update); preserve all
reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — standalone CSV pool declarations (K6F1-03d)

Use strict version 1 `csvPoolParametersSchema` and inferred types without changing
reviewed graph/value/HTTP/auth/check contracts. See [the CSV guide](api/graph.md#standalone-csv-pool-declarations-k6f1-03d).

| Decision | Rationale / consequence |
|----------|-------------------------|
| External attachment identity only | Human-approved source boundary; strict opaque nonblank `{ id }`, not inline CSV or URL/path/secret alternative fields. Identity validation supplies no resolver or security guarantee. |
| Explicit stable CSV-order distinct row per VU | Each VU keeps its assigned row across iterations; no sharing, wrapping, random allocation or iteration rotation. Assignment is not implemented. |
| Explicit reject-before-execution capacity policy | A future consumer must fail before execution when distinct rows cannot cover required VUs; standalone validation neither counts rows nor proves capacity/readiness. |
| Nonempty required header-to-string mappings | Exact named headers map to unique structural output identities; required/string literals prevent optional outputs, conversion or trimming. Repeated source-header mappings with different output names are allowed, without deciding duplicate actual CSV-header handling. |
| Phase 6 ingestion and security obligations | SharedArray loading, column presence, capacity and assignment remain future work. Consumers must avoid CSV/credential logs and minimize retention; neither control is enforced here. |

CSV dialect/encoding, duplicate actual headers, malformed rows and VU assignment
mechanics remain deferred, with no implicit defaults. K6F1-03f owns output catalogs,
type compatibility, reference reconciliation and execution readiness.
Runtime harness: N/A; pure declarations add no ingestion, process or network boundary.
Rollback only CSV modules/tests, additive CSV exports, the CSV guide section and
these notes; preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — standalone global load and thresholds (K6F1-03e)

Use strict version 1 `loadParametersSchema` and inferred types without changing
reviewed contracts. See [the load guide](api/graph.md#standalone-global-load-and-thresholds-k6f1-03e).

| Decision | Rationale / consequence |
|----------|-------------------------|
| One tagged global profile | Human-approved constant-VU duration or staged/ramping VUs; no per-node overrides, concurrent scenarios, iterations or arrival-rate executors. |
| Explicit safe-integer milliseconds and VUs | Durations and constant VUs are positive; staged startup/targets are nonnegative with some positive load. Nonempty stages retain input order, including ramp-down to zero; no defaults, coercion or quantity/unit alternatives. |
| Structured HTTP thresholds with explicit units | Latency Trend avg/p90/p95/p99 uses finite nonnegative milliseconds, including fractions. Failure Rate uses finite fractions `[0,1]`. Strict metric/aggregator/unit pairings prevent conversion ambiguity; no custom metrics, tags or arbitrary percentiles. |
| Explicit possibly empty threshold list | Empty declares no threshold criteria. Repeated metrics are valid, consistent with k6 threshold arrays; no unique metric, ID or label requirement. |
| Six numeric operators and fixed final pass/fail | Reuse eq/ne/lt/lte/gt/gte without evaluating predicates. End-of-execution intent excludes early abort/delay; response checks remain record-failure-and-continue. |

Parent-provided primary evidence: [Grafana threshold guide](https://grafana.com/docs/k6/latest/using-k6/thresholds/)
for final pass/fail, Trend milliseconds and abort distinctions; [k6 v0.55.0 parser](https://raw.githubusercontent.com/grafana/k6/v0.55.0/metrics/thresholds_parser.go)
for corresponding numeric comparators. This is not installed-runner/version proof.
Engine-specific duration representability, graceful-stop and startup-delay settings
remain later decisions. REST precedence/status mapping belongs to K6F1-04; graph
composition/readiness to K6F1-03f, translation to Phase 5, CSV capacity/allocation to
Phase 6. No aggregation, metrics WS or executor implementation is introduced.
Runtime harness: N/A; typed declarations are not proof of a k6 execution.
Rollback only load modules/tests, additive load exports, the load guide section and
these notes; preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — typed graph composition (K6F1-03f)

Bind reviewed parameter contracts to structural node kinds additively; existing
modules stay unchanged. See [the composition guide](api/graph.md#typed-draft-and-ready-graph-composition-k6f1-03f).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Structural kinds retained with kind-typed `parameters` | Ready graphs must pass the reviewed execution topology, which only admits `authentication`, `http-request`, `response-validation` and `user-pool`; each kind gains optional (draft) or required (ready) parameters validated by its reviewed schema, without altering those modules. |
| Built-in reserved `response` output | Every `http-request` exposes exactly one `http-response` output, even without parameters; declared authentication/CSV outputs may not use the name. Checks consume only `http-response` through their existing `response` identity; authentication exposes declared extraction outputs only, never a raw response. |
| Exact-set reference reconciliation | Declared `node.references` equal references embedded in supported slots (URL/header/query values, text/JSON bodies, authentication request fields, checks `response`); order and duplicates ignored, exact comparison without normalization, dangling or undeclared references reject in draft and ready. Counting the checks `response` identity lets the reviewed topology enforce its precedence uniformly. |
| Slot/type compatibility, precedence only when ready | String outputs feed string consumers and count as JSON data; JSON outputs never feed string consumers; `http-response` feeds checks only. Producer existence, catalog membership and type match hold in drafts; connection-order precedence is enforceable only on the reviewed linear topology, so it is a ready-graph guarantee. |
| Draft/ready readiness split | Draft nodes may omit whole parameter objects and `load`; present payloads must be fully valid. Ready graphs require every parameter, the linear topology and a top-level global `load`. |

Declaration only: no runtime resolution, response-value validation, script
translation, executors, REST precedence, CSV ingestion, recorder or UI.
Runtime harness: N/A; composition validators are pure declarations. Rollback only
the composition modules/tests, additive exports, the composition guide section
and these notes; preserve reviewed contracts, parent tracking and unrelated
surfaces.

## Phase 1 — runs/health REST contract declarations (K6F1-04)

Declare strict version 1 runs REST request/response schemas, a pure idempotency
derivation and a hand-written OpenAPI 3.1 document without handlers or runtime.
See [the runs guide](api/runs.md).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Async lifecycle with idempotent start | `POST /api/runs` answers `202` + runId; an identical `Idempotency-Key` and payload replays `200` with the existing runId while an absent key always creates; stop answers `202`, unknown runId `404`, premature summary `409`. Dedupe is a pure derivation over caller-supplied records, never a store. |
| Exact five-status closed set | `pending`/`running`/`finished`/`failed`/`stopped`; `finished` means normal completion including threshold evaluation (only that final summary carries `thresholdsPassed`), `failed` is reserved for engine/infra errors. |
| Opaque compiled script with REST override | The payload carries an already compiled script string, never a graph, parsed k6 options or evaluated thresholds; REST `vus`/`durationMs` always override script-embedded options; `cpuMillis`/`memoryMiB` are required positive safe integers; attachments are opaque ids without byte upload. |
| Static bearer auth and explicit version | Every `/api/*` route requires `Authorization: Bearer <token>` (`401` otherwise) and all API bodies carry the literal `version: 1`; the public unversioned `/healthz` remains process-only and untouched. |

Declaration only: no handlers, servers, idempotency store, schedulers or threshold
evaluation; the cumulative final summary stays separate from the K6F1-05 windowed
WebSocket topic. Runtime harness: N/A; pure declarations add no process/network
boundary. Rollback only the runs-rest module/tests, additive index exports,
`api/runs.md`, `api/openapi.yaml` and these notes; preserve reviewed contracts,
parent tracking and unrelated surfaces.

## Phase 1 — metrics WebSocket contract declarations (K6F1-05)

Declare the strict versioned metrics frame for the run-scoped WebSocket topic
without handlers or transport. See [the WS metrics guide](api/ws-metrics.md).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Same-origin Next proxy routing | The browser connects to `/api/ws/runs/{runId}`; a Next proxy rewrite forwards to the orchestrator internal port, which stays unexposed. Documentation only — no proxy or socket code ships here. |
| Fixed 1000 ms window, run-relative `startMs` | Literal `durationMs: 1000` with a nonnegative safe-integer `startMs` measured from run start (not epoch); `seq` is a nonnegative safe integer, monotonic per run as a documented producer obligation the schema cannot enforce. |
| Explicit ms/fraction units | Latency avg/p90/p95/p99 are finite nonnegative milliseconds, `httpFailureFraction` a finite `[0,1]` fraction, `reqPerSec` finite ≥ 0, `activeVUs`/`failedChecks` nonnegative safe integers — no percentages, microseconds or counts-as-float. |
| Explicit `null` for no-sample windows | When a window had no requests, `reqPerSec`, all four percentiles and `httpFailureFraction` are `null` exactly together — never a silent 0 — while counts stay counts and `0` is meaningful. |
| Metrics frame only | The discriminated union is closed to `type: "metrics"`; terminal, error and reconnect/replay frames, aggregation, broadcast and cross-frame sequence enforcement are deferred to distinct capabilities. |

Declaration only: no handlers, sockets, servers, aggregation or broadcast; the
windowed topic stays separate from the K6F1-04 cumulative final summary.
Runtime harness: N/A; pure declarations add no process/network boundary. Rollback
only the metrics module/tests, additive exports, `api/ws-metrics.md` and these
notes; preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 1 — recorder REST/WS contract declarations (K6F1-06)

Declare strict version 1 recorder REST request/response schemas, the WS input
frame and the OpenAPI recorder section without handlers or runtime. See
[the recorder guide](api/ws-recorder.md).

| Decision | Rationale / consequence |
|----------|-------------------------|
| Explicit closed lifecycle and cleanup-trigger sets | `pending|recording|stopping|completed|failed` and `run-finished|closed|inactivity|max-duration|manual`; declarations only, no state machine implementation. |
| Idempotent stop with exact-once capture | Repeated stop returns the same terminal state without extra effect; capture delivered exactly once is a runtime obligation; no structured error for repeated stop because it is idempotent, not an error. |
| Raw HTTP transcript capture, not graph AST | Capture entries are `{method, url, status, headers, bodyExcerpt?, redacted}` — explicitly not the graph HTTP-node literal/reference AST; import→graph mapping is deferred. |
| Static bearer auth on REST and WS handshake | `Authorization: Bearer <token>` on all `/api/recorder/*` routes and on the recording WS handshake `/ws/recordings/{recordingId}` (`401` uniform); consistent with the runs REST contract. |

Declaration only: no handlers, sockets, containers, Docker, byte transport,
redaction implementation, secret visibility/retention config, filter logic or
recording runtime. Runtime harness: N/A; pure declarations add no process/network
boundary. Rollback only the recorder module/tests, additive exports,
`api/ws-recorder.md`, the recorder section in `api/openapi.yaml` and these notes;
preserve reviewed contracts, parent tracking and unrelated surfaces.

## Phase 0 decisions

These decisions implement the approved foundation without deciding later
product contracts. The original product and UX inputs under `doc/` are preserved.

| Decision | Rationale / consequence |
|----------|-------------------------|
| PostgreSQL 17.7, Alpine 3.22 | PostgreSQL was explicitly selected; named-volume persistence uses the version 17 data directory. |
| Node 22.22.0, pnpm 10.32.1 | Compatible with Next 16.1.6 and the existing pinned workspace; explicit image/toolchain versions avoid floating `latest`. |
| Go 1.25.7, Alpine 3.23 | Supports the module's Go 1.22 language baseline; the binary needs no C runtime. |
| Alpine 3.23.3 Go runtime | BusyBox provides the HTTP health probe without adding a reload or probe framework. |
| Next standalone production output | Copies only runtime dependencies and generated assets into a non-root final image. |
| Process-only web/Go health | No database client exists yet; a green process must not imply DB connectivity or application readiness. |
| Internal backend; loopback web binding | Go/database have no published ports; web is local-only until HTTPS and access control are designed. |
| Web app reload; manual Go restart/rebuild | Native Next development behavior and Go tooling suffice; no reload framework dependency. |
| TypeScript checking and Go vet baseline | Uses available tooling for meaningful static checks; no gratuitous ESLint dependency or style-policy invention. |
| YAML parser in deployment tests | Checks structured service/network/health contracts instead of formatting snapshots. |
| Allowlisted Docker build context | Excludes secrets, host outputs and original assets without changing `.gitignore`. |
| Disposable runtime projects | Real startup tests must not adopt an existing stack or delete its data; startup/cleanup failures stay failures. |

## Constraints and operational caveats

Version tags are pinned, not immutable digests. Updates and vulnerability scanning
policy remain future hardening; this CI provides checks, not a security certification.
The dummy example is for local disposable use only. Production credentials belong
outside the repository; existing database credentials require explicit rotation.
The database volume persists through ordinary `down` and must be backed up before
any deliberate deletion or upgrade. A development Go bind includes the source
directory, so keep real credentials outside that directory as well.

## Pending human decisions

Authentication and roles, retention, WebSocket routing, Playwright versus
Puppeteer, reverse proxy/HTTPS and Docker Engine privilege mitigation remain
unresolved. Phase 0 does not implement them, grant socket access or simulate them
through placeholder product endpoints. Stop for review before Phase 1.
