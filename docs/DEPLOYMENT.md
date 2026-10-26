# K6Flow Deployment Guide

Single-command deployment for a clean VPS.

## Prerequisites

- Docker 24+ with Docker Compose v2
- Domain name pointing to your server (for HTTPS)
- Ports 80, 443 available
- Access to `/var/run/docker.sock` on the host: the orchestrator launches one k6 container per run

## Quick Start (Production)

All commands run from the repository root.

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
#   ALLOWED_TARGETS=            empty on purpose: deploy/.env.example ships
#                               ALLOWED_TARGETS=true, which restricts the
#                               allow-list to a host literally named "true"
#   DATABASE_URL=postgresql://k6flow:<POSTGRES_PASSWORD>@db:5432/k6flow
#                               must use the same password as POSTGRES_PASSWORD

# 4. Add the Docker socket to the orchestrator.
#    deploy/docker-compose.yml does not mount docker.sock (production stays
#    socket-free on purpose, see tests/phase-0-compose.test.ts) and
#    deploy/docker-compose.prod.yml only touches caddy and web. Without the
#    socket the orchestrator cannot create the per-run k6 containers and every
#    execution fails. This override file is yours: keep it out of version control.
cat > deploy/docker-compose.socket.yml <<'EOF'
services:
  orchestrator:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
EOF

# 5. Apply the migrations and create the admin user.
#    The one-shot `setup` service does both (apps/web/Dockerfile, target `setup`):
#    the production web image is the Next.js standalone build, so it cannot run
#    the seed itself. This also starts the database it depends on and exits when
#    done; running it again is safe (applied migrations are skipped and the admin
#    is upserted by username).
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.socket.yml \
  run --rm setup

# 6. Deploy with HTTPS
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.socket.yml \
  up -d

# 7. Wait until every service reports healthy.
#    `up -d` returns before the healthchecks pass, so poll `ps` until
#    web, orchestrator, recorder, db and caddy all show (healthy).
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.socket.yml \
  ps
```

Your k6flow instance is now running at `https://your-domain.com`.

> Si preferís no compilar nada, cada tag `vX.Y.Z` publica imágenes en GHCR y el repo incluye
> `deploy/docker-compose.release.yml` para levantar K6Flow sólo con `docker compose`. Es el camino
> recomendado (y el que usan las pruebas de aceptación): ese stack ya monta el socket y su servicio
> `setup` corre las migraciones y el seed solo, así que no hacen falta los pasos 4 y 5. Ver
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
| `WEB_PORT` | `3000` | Host port the web UI is published on. Change it here: adding a second compose file with a `ports:` entry does **not** replace the mapping, because Compose merges the lists and the app ends up published on both ports |
| `ALLOWED_TARGETS` | (empty) | Comma-separated allowed test targets. Only the `release` and `all-in-one` stacks forward it to the web tier |
| `ENDPOINT_TEST_ALLOWED_TARGETS` | (empty) | Comma-separated `host:port` entries the endpoint test may contact. Fail-closed: absent, empty or malformed denies every target, unlike `ALLOWED_TARGETS`. No compose file forwards it today |
| `RECORDER_AUTH_TOKEN` | `dev-token` | Token shared by the recorder service and the web tier. The web tier uses it to stop a recording and read its capture back, so both must receive the same value. The default differs per stack, see below |
| `RECORDER_MAX_DURATION_MS` | `3600000` | Longest single recording the recorder allows before it stops itself |
| `RECORDER_INACTIVITY_MS` | `300000` | Idle time after which the recorder stops a recording with no connected client |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error). Read only by the orchestrator; no compose file forwards it today |

Captures are written as NDJSON under the recorder's `CAPTURE_DIR`
(`/var/lib/k6flow/captures`). The volume behind that path is `recorder-captures` in
`deploy/docker-compose.yml` and `deploy/docker-compose.release.yml`, and `captures` in
`deploy/docker-compose.all-in-one.yml`. A stop copies the capture into
`recordings.capture_data`, which is what the review screen and the recordings
list read, so a recorder restart does not lose recordings the library already collected.

### Wiring notes

- **`ALLOWED_TARGETS` and `.env.example`**: `deploy/.env.example` ends with `ALLOWED_TARGETS=true`
  in a duplicated block (there is an earlier `ALLOWED_TARGETS=` too), so copying it does **not**
  leave the value empty: it restricts the allow-list to a host named `true`. Only
  `deploy/docker-compose.release.yml` and `deploy/docker-compose.all-in-one.yml` forward the
  variable to the `web` service; the base stack ignores it.
- **`ENDPOINT_TEST_ALLOWED_TARGETS`**: no compose file forwards it. Add it to the `environment:`
  block of the `web` service, otherwise the fail-closed default keeps the feature disabled.
- **`LOG_LEVEL`**: only the orchestrator reads it, and no compose file forwards it. Add it to the
  `environment:` block of the `orchestrator` service.
- **`RECORDER_AUTH_TOKEN`**: the default is `dev-token` in `deploy/docker-compose.yml` and in
  `deploy/all-in-one/start.sh`, and `k6flow-internal-token` in
  `deploy/docker-compose.release.yml`. Whatever you pick, the value received by `web` and by the
  recorder must be identical, or stopping a recording and reading its capture fails.

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

# Migrations + admin seed (the dev stack does not run them on boot)
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.dev.yml \
  run --rm setup
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

# Rebuild and restart (add -f deploy/docker-compose.socket.yml as a third -f if
# you created your own socket override in the quick start)
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  up -d --build

# Apply the migrations added since the previous revision and refresh the admin.
# Idempotent: drizzle skips applied migrations and the seed upserts by username.
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  run --rm setup
```

## Backup

```bash
# Backup database
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  exec db pg_dump -U k6flow k6flow > backup.sql

# Restore
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.prod.yml \
  exec -T db psql -U k6flow k6flow < backup.sql
```

## Troubleshooting

Run every command from the repository root; if you `cd deploy`, drop the `deploy/` prefixes.

### Services not starting

```bash
# Check logs
docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml logs -f web
docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml logs -f orchestrator

# Verify health
docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml ps
```

### HTTPS not working

1. Verify domain DNS points to your server
2. Check Caddy logs (the `caddy` service only exists with the `prod` overlay):
   `docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml logs caddy`
3. Ensure ports 80/443 are open in firewall

### Database connection issues

1. Wait for db health check to pass
2. Verify DATABASE_URL matches POSTGRES_* variables
3. Check db logs: `docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml logs db`

## Support

- Issues: https://github.com/your-org/k6flow/issues
- Docs: `docs/` directory
