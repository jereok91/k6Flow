# K6Flow all-in-one: la app completa en una sola imagen (web + orchestrator + recorder).
#
# El compose de al lado sólo agrega PostgreSQL, como yopass agrega redis:
#   image: ghcr.io/jereok91/k6flow:0.2.0
#   ports: ["3000:3000"]
#   environment: { DATABASE_URL: ... }
#
# El orquestador necesita /var/run/docker.sock para lanzar un contenedor de k6 por ejecución.
FROM node:22.22.0-bookworm-slim AS workspace
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/recorder/package.json apps/recorder/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/recorder apps/recorder
# Los rewrites de Next se hornean en el build: en la imagen todo corre en el mismo
# contenedor, así que apuntan a loopback en lugar de a los nombres de servicio del compose.
RUN RECORDER_UPSTREAM=http://127.0.0.1:8081 \
    ORCHESTRATOR_WS_UPSTREAM=http://127.0.0.1:8080 \
    pnpm --filter @k6flow/web build

FROM golang:1.25.7-alpine3.23 AS orchestrator
WORKDIR /src
COPY apps/orchestrator/go.mod apps/orchestrator/go.sum ./
RUN go mod download
COPY apps/orchestrator ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/orchestrator ./cmd/server

# Base de Playwright: trae Chromium y sus dependencias de sistema para el grabador.
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS runtime
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Playwright publica Node 20; la app pide Node 22 (mismo glibc family), así que se copia el binario.
COPY --from=node:22.22.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ORCHESTRATOR_INTERNAL_URL=http://127.0.0.1:8080 \
    ORCHESTRATOR_WS_UPSTREAM=http://127.0.0.1:8080 \
    RECORDER_UPSTREAM=http://127.0.0.1:8081 \
    ORCHESTRATOR_SERVICE_TOKEN=k6flow-internal-token \
    RECORDER_AUTH_TOKEN=dev-token

WORKDIR /app

# Standalone de Next + estáticos.
COPY --from=workspace /workspace/apps/web/.next/standalone ./
COPY --from=workspace /workspace/apps/web/.next/static ./apps/web/.next/static

# Workspace para el grabador y para migraciones/seed (necesitan drizzle, pg y las fuentes TS).
# Las rutas se copian absolutas porque start.sh trabaja desde /workspace.
COPY --from=workspace /workspace/packages /workspace/packages
COPY --from=workspace /workspace/apps/web/lib /workspace/apps/web/lib
COPY --from=workspace /workspace/apps/web/scripts /workspace/apps/web/scripts
COPY --from=workspace /workspace/apps/web/package.json /workspace/apps/web/package.json
COPY --from=workspace /workspace/apps/web/node_modules /workspace/apps/web/node_modules
COPY --from=workspace /workspace/apps/recorder /workspace/apps/recorder
COPY --from=workspace /workspace/node_modules /workspace/node_modules
COPY --from=workspace /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/
COPY --from=orchestrator /out/orchestrator /app/orchestrator

COPY deploy/all-in-one/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3000
# tini (init: true en compose) reenvía señales; el script corta los tres procesos juntos.
ENTRYPOINT ["/app/start.sh"]
