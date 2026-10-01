# K6Flow — Phase 0 foundations

A minimal Next.js web process, internal Go orchestrator and PostgreSQL stack.
This phase does **not** execute load tests, record sessions or persist application data.
Health endpoints report process availability, not database connectivity.

## Quick start

Prerequisites: Docker Engine with Compose v2+; Node 22.22.0, pnpm 10.32.1
and Go 1.25.7 for host-side checks. The images pin matching toolchain versions.

For a disposable local stack, the example contains dummy credentials only:

```sh
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml up --build --wait
curl --fail http://127.0.0.1:3000/api/healthz
```

Only web is published, on loopback port 3000. Go listens on port 8080 inside
Compose; PostgreSQL has no host port. This is a local foundation, **not** a
public HTTPS deployment. Choose a reverse proxy and authentication in later phases.
For non-disposable use, supply an env file outside the repository with a new
`POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` and optional `WEB_PORT`.
Never commit real credentials. Changing the password variable does not rotate an
existing database volume's password.

## Development

```sh
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up --build --wait
```

- Web's `app/` source is mounted read-only; Next.js reloads application changes.
- Go source is mounted read-only. After editing it, run the following restart;
  the container rebuilds into its own `/tmp` before starting. There is no reload framework.
- Manifest, Next config, TypeScript config or toolchain changes require a rebuild.
  Web binds only `app/`, deliberately avoiding host dependencies and secrets.

```sh
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml restart orchestrator
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up --build --wait
```

Stop the chosen stack with the same file arguments and `down`. Ordinary shutdown
retains PostgreSQL's named volume. Do not use `down --volumes` on data you need.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm --filter @k6flow/web build
(cd apps/orchestrator && go test ./...)
(cd apps/orchestrator && go vet ./...)
(cd apps/orchestrator && go build ./...)
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml config
bash scripts/check-phase-0-compose.sh
```

`pnpm lint` is the baseline static check: strict TypeScript checking plus Go vet,
not an ESLint/style claim. Tests cover health routing and parsed YAML deployment
contracts, including rejected public Go ports and unexpected services. CI runs
the same boundaries; its runtime job requires a working Docker daemon.

The runtime harness checks production **and** development in unique disposable
projects, uses an ephemeral loopback web port, waits for all three health checks,
probes web from the host and Go from a separate client process in web, and checks
that Go/PostgreSQL publish no ports. Startup is capped at 900 seconds per stack;
cleanup is capped at 60 seconds per project. It removes only its own containers,
networks, database volumes and exact project-built image tags. Shared base images
and build cache are retained. No prune, existing-volume
removal, daemon installation or permission repair is attempted. A failed startup
or cleanup is a failed check, not evidence of a healthy stack.

## Read next

- [Architecture](docs/ARQUITECTURA.md): current boundaries versus future intent.
- [Decisions](docs/DECISIONES.md): toolchain, health and isolation rationale.
- Original product and UX inputs remain untouched under `doc/`.

Stop after Phase 0 review. Contracts, authentication, Docker Engine access,
WebSocket routing, recorder choice and retention are intentionally pending.
