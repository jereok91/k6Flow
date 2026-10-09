# k6flow — Variables and environments (Postman-style)

## Goal
Let users define variables (baseUrl, token, ...) and reference them as `{{name}}` in HTTP Request URL, headers and body.

## Decisions (user, 2026-10-09)
- Scope: global **environments** (dev/staging/prod, owned by the user, selectable at run time) + **scenario variables**; scenario variables override environment variables with the same name.
- Secrets: a variable can be marked **secret**: masked in the UI, never returned in plaintext by the API after save, excluded from scenario export and version history, and passed to k6 as an environment variable (`__ENV.NAME`) instead of being written into the script.
- Static only for now: no runtime extraction from responses (dynamic values keep using Authentication node / references).

## Design notes
- Syntax: `{{name}}`, name = `[A-Za-z_][A-Za-z0-9_.-]{0,63}`; unknown variables are a validation warning in the editor and a translation error at run time.
- Translation (client, packages/shared): non-secret values are inlined as JSON-escaped string literals; secret values become `__ENV["K6FLOW_VAR_<NAME>"]`; mixed strings use template literals with escaped literal parts.
- Run (server): the web run proxy resolves secret values from the DB (environment + scenario, scenario wins) and forwards them as env to the orchestrator; values never travel to the browser.

## Tasks
- [x] T1 Shared: `{{var}}` parser/validator + translator interpolation (literal vs `__ENV`), tests — `5b49dd5`
- [ ] T2 DB + API: environments, environment variables, scenario variables (secret masking, export/version exclusion), tests
- [ ] T3 Run integration: environment selection, merge rules, secret env injection through web proxy + orchestrator run env (validated), tests
- [ ] T4 Editor UI: environments manager, scenario variables panel, environment selector by Ejecutar, `{{var}}` highlight/autocomplete + unresolved warnings

## Evidence
- T1: RED (module missing + 14 failing) -> GREEN shared 19 files / 788 tests; shared + web tsc clean. Emitted: `http.get("https://api.example.com" + "/auth/login"` and `'Authorization': "Bearer " + __ENV["K6FLOW_VAR_TOKEN"]`.
- T1 notes for T3: run layer must pass `variables` (no option = no interpolation) and inject every `requiredEnv`; JSON bodies insert non-secret values raw (Postman-like).
