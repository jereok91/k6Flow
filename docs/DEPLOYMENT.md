# K6Flow Deployment Guide

Single-command deployment for a clean VPS.

## Prerequisites

- Docker 24+ with Docker Compose v2
- Domain name pointing to your server (for HTTPS)
- Ports 80, 443 available

## Quick Start (Production)

```bash
# 1. Clone the repository
git clone https://github.com/your-org/k6flow.git
cd k6flow

# 2. Create environment file
cp deploy/.env.example deploy/.env

# 3. Edit .env with your values
nano deploy/.env
# Required:
#   POSTGRES_PASSWORD=<strong-random-password>
#   ADMIN_PASSWORD=<min-12-chars>
#   DOMAIN=k6flow.yourdomain.com

# 4. Deploy with HTTPS
cd deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 5. Check status
docker compose ps
```

Your k6flow instance is now running at `https://your-domain.com`.

> Si preferís no compilar nada, cada tag `vX.Y.Z` publica imágenes en GHCR y el repo incluye
> `deploy/docker-compose.release.yml` para levantar K6Flow sólo con `docker compose`. Ver
> [RELEASES.md](RELEASES.md).

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password | `random-32-char-string` |
| `ADMIN_PASSWORD` | Initial admin user password (min 12 chars) | `MySecurePass123!` |
| `DOMAIN` | Your domain for HTTPS | `k6flow.example.com` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `WEB_PORT` | `3000` | Internal web server port |
| `ALLOWED_TARGETS` | (empty) | Comma-separated allowed test targets |
| `ENDPOINT_TEST_ALLOWED_TARGETS` | (empty) | Comma-separated `host:port` entries the endpoint test may contact. Fail-closed: absent, empty or malformed denies every target, unlike `ALLOWED_TARGETS` |
| `RECORDER_AUTH_TOKEN` | `dev-token` | Token shared by the recorder service and the web tier. The web tier uses it to stop a recording and read its capture back, so both must receive the same value |
| `RECORDER_MAX_DURATION_MS` | `3600000` | Longest single recording the recorder allows before it stops itself |
| `RECORDER_INACTIVITY_MS` | `300000` | Idle time after which the recorder stops a recording with no connected client |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |

Captures are written as NDJSON under the recorder's `CAPTURE_DIR`
(`/var/lib/k6flow/captures`, kept on the `recorder-captures` volume). A stop copies the
capture into `recordings.capture_data`, which is what the review screen and the recordings
list read, so a recorder restart does not lose recordings the library already collected.

## Architecture

```
Internet → Caddy (443) → web (3000) → orchestrator (8080) → K6 containers
                                   → db (5432)
                                   → recorder (8081)
```

### Networks

- **edge**: Public-facing services (Caddy, web, recorder)
- **backend**: Internal services (db, orchestrator)
- **k6runner**: Isolated network for K6 test containers

## Development Setup

```bash
# Run in development mode with hot reload
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.dev.yml \
  up --build
```

Access at `http://localhost:3000`.

## Security Considerations

1. **Docker Socket**: The orchestrator needs Docker socket access. For shared VPS, consider Docker rootless. See `docs/DECISIONES.md#K6F9-05`.

2. **SSRF Protection**: K6 and recorder are network-isolated from internal services.

3. **Allowed Targets**: Set `ALLOWED_TARGETS` to restrict which hosts K6 can test.

4. **Credentials**: Never commit `.env` files. Use strong passwords.

5. **Endpoint Test Allow-List**: `ENDPOINT_TEST_ALLOWED_TARGETS` is fail-closed, so an unset variable disables the feature instead of opening it. The test runs inside the web server behind an authenticated session, pins the connection to an address that list already approved (no second DNS resolution), never follows redirects, allows GET/POST/PUT/PATCH/HEAD only, bounds the whole operation to a 5 s deadline with 64 KiB request and response caps, and masks sensitive response headers and every resolved secret value before returning anything.

## Updating

```bash
cd k6flow
git pull
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

## Backup

```bash
# Backup database
docker compose exec db pg_dump -U k6flow k6flow > backup.sql

# Restore
cat backup.sql | docker compose exec -T db psql -U k6flow k6flow
```

## Troubleshooting

### Services not starting

```bash
# Check logs
docker compose logs -f web
docker compose logs -f orchestrator

# Verify health
docker compose ps
```

### HTTPS not working

1. Verify domain DNS points to your server
2. Check Caddy logs: `docker compose logs caddy`
3. Ensure ports 80/443 are open in firewall

### Database connection issues

1. Wait for db health check to pass
2. Verify DATABASE_URL matches POSTGRES_* variables
3. Check db logs: `docker compose logs db`

## Support

- Issues: https://github.com/your-org/k6flow/issues
- Docs: `docs/` directory
