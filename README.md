# K6Flow — Visual Load Testing Platform

A visual editor for creating and executing K6 load tests. Draw your test scenario, capture real traffic, and run distributed load tests with live metrics.

## Features

- **Visual Editor**: Drag-and-drop nodes to build test scenarios
- **Traffic Recorder**: Capture real HTTP traffic and convert to test nodes
- **K6 Integration**: Translate visual graphs to K6 scripts automatically
- **Live Metrics**: Real-time VU counts, request rates, and latency percentiles
- **User Pools**: CSV-based test data for parameterized tests
- **Authentication**: Built-in auth nodes with token extraction

## Quick Start

### Development

```bash
# Clone and setup
git clone https://github.com/your-org/k6flow.git
cd k6flow

# Start all services
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.dev.yml \
  up --build --wait

# Access the editor
open http://127.0.0.1:3000
```

Default admin credentials: `admin` / `change-me-min-12-chars`

### Published images (no clone needed)

Every `vX.Y.Z` tag publishes `ghcr.io/jereok91/k6flow-{web,orchestrator,recorder,setup}`. To run
K6Flow from the published images:

```bash
curl -O https://raw.githubusercontent.com/jereok91/k6Flow/main/deploy/docker-compose.release.yml
printf 'POSTGRES_PASSWORD=change-me\nADMIN_PASSWORD=change-me-min-12-chars\nK6FLOW_VERSION=latest\n' > .env
docker compose -f docker-compose.release.yml up -d
```

See [docs/RELEASES.md](docs/RELEASES.md) for cutting a release, pinning versions and upgrading.

### Production from source

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full VPS deployment guide.

```bash
# Quick production deploy
cp deploy/.env.example deploy/.env
# Edit .env with your domain and passwords
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│   Caddy     │────▶│    Web      │
│             │     │   (HTTPS)   │     │  (Next.js)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┼───────────────┐
                    │                          │               │
                    ▼                          ▼               ▼
             ┌─────────────┐          ┌─────────────┐   ┌─────────────┐
             │  Recorder   │          │ Orchestrator│   │  PostgreSQL │
             │   (Go)      │          │    (Go)     │   │             │
             └─────────────┘          └──────┬──────┘   └─────────────┘
                                             │
                                             ▼
                                      ┌─────────────┐
                                      │ K6 Containers│
                                      │  (on-demand) │
                                      └─────────────┘
```

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md) — Production installation
- [Architecture](docs/ARQUITECTURA.md) — System design decisions
- [API Reference](docs/api/) — REST and WebSocket contracts
- [Decisions](docs/DECISIONES.md) — Technical decisions and rationale

## Development

### Prerequisites

- Docker 24+ with Compose v2
- Node.js 22.22.0, pnpm 10.32.1 (for local tests)
- Go 1.25.7 (for local Go tests)

### Testing

```bash
# TypeScript tests
pnpm install --frozen-lockfile
pnpm test

# Go tests
cd apps/orchestrator && go test ./...
cd apps/recorder && go test ./...

# Type checking and linting
pnpm typecheck
pnpm lint
```

### Project Structure

```
k6flow/
├── apps/
│   ├── web/           # Next.js frontend + API
│   ├── orchestrator/  # Go service for K6 execution
│   └── recorder/      # Go service for traffic capture
├── packages/
│   └── shared/        # TypeScript contracts and utilities
├── deploy/            # Docker Compose and Caddy configs
├── docs/              # Documentation
└── tests/             # E2E tests
```

## Security

- **Allowed Targets**: Configure `ALLOWED_TARGETS` to restrict test destinations
- **Endpoint Test Allow-List**: Configure `ENDPOINT_TEST_ALLOWED_TARGETS` with exact `host:port` entries to enable "Probar endpoint" on an HTTP node. An absent, empty or malformed list denies every target. The test sends one bounded request, never follows redirects, and masks sensitive headers and resolved secrets in everything it returns
- **Run Confirmation**: Explicit confirmation required before executing tests
- **Network Isolation**: K6 containers isolated from internal services
- **Credential Handling**: Passwords hashed, tokens secure, no secrets in logs

See [docs/DECISIONES.md](docs/DECISIONES.md) for detailed security practices.

## License

[Your License Here]

## Contributing

[Contributing guidelines]
