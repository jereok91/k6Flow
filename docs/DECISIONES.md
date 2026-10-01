# Phase 0 decisions

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
