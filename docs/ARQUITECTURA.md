# Phase 0 architecture

The runnable foundation has exactly three services. It proves packaging and
process availability, not the future product's end-to-end behavior.

```text
Host localhost:3000 -> web (Next.js, :3000)
                         |
                   backend network (internal)
                         |
              orchestrator (Go, :8080)    db (PostgreSQL, :5432)
```

The vertical line is network reachability, **not** an implemented control API or
database client. Web also joins an edge network for its loopback host binding;
Go and PostgreSQL join only the internal backend network.

## Current boundaries

| Component | Implemented | Not implemented |
|-----------|-------------|-----------------|
| Web | Minimal page; `/api/healthz` returns `{"status":"ok"}` | Auth, editor, persistence, translators |
| Go | `/healthz` returns `{"status":"ok"}` on port 8080 | Control API, Docker SDK, metrics |
| PostgreSQL | Persistent named volume; `pg_isready` health probe | Application schema, migrations, clients |

Web and Go health checks are process-only and independent of database state.
PostgreSQL's probe indicates that the database accepts connection attempts; it
is not a migration, credential or application-readiness test. There are no
startup dependency gates that imply application integration.

## Build and development boundaries

Production uses multi-stage builds: Next standalone output runs as `node`; the
static Go binary runs as an unprivileged Alpine user. The root build context is
allowlisted in `.dockerignore`; user docs, UX assets, env files, Git metadata,
host dependencies and generated outputs are excluded. Build tools never need a
Docker socket. Development mounts only web application code and read-only Go
source; outputs live inside the disposable containers. Go rebuilds on restart.

## Future intent, not current behavior

The product brief selects a Next.js-owned graph translator, REST control to Go,
WebSocket metrics and ephemeral K6/recorder containers. Those contracts require
later review. There is no permanent K6/recorder service, Docker socket mount,
reverse proxy, host Go port or host database port in this foundation.

Before Engine access, decide its privilege boundary and SSRF/network controls.
Before public deployment, decide HTTPS, authentication and service authorization.
See [decisions](DECISIONES.md) and [operating commands](../README.md).
