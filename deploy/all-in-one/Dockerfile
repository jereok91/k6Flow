# K6Flow todo en uno: la app completa en una sola imagen.
#
# Dos targets:
#   all-in-one  → web + orchestrator + grabador (Chromium) + migraciones
#   slim        → web + orchestrator + migraciones, sin grabador (mucho más chica)
#
# El compose de al lado sólo agrega PostgreSQL, como yopass agrega redis.
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
# Los rewrites de Next se hornean en el build: en esta imagen todo corre en el mismo
# contenedor, así que apuntan a loopback en vez de a los nombres de servicio del compose.
RUN RECORDER_UPSTREAM=http://127.0.0.1:8081 \
    ORCHESTRATOR_WS_UPSTREAM=http://127.0.0.1:8080 \
    pnpm --filter @k6flow/web build
# El grabador se empaqueta en un único archivo: en ejecución no necesita tsx ni devDependencies.
RUN pnpm --filter @k6flow/recorder exec esbuild src/main.ts --bundle --platform=node \
    --format=esm --outfile=/out/recorder.mjs --external:playwright --external:ws

# Sólo dependencias de producción: recorta cientos de MB frente al workspace completo.
FROM node:22.22.0-bookworm-slim AS prod-deps
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/recorder/package.json apps/recorder/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --prod --frozen-lockfile

FROM golang:1.25.7-alpine3.23 AS orchestrator
WORKDIR /src
COPY apps/orchestrator/go.mod apps/orchestrator/go.sum ./
RUN go mod download
COPY apps/orchestrator ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/orchestrator ./cmd/server

# Contenido común de la app: standalone de Next, workspace mínimo y binario Go.
FROM node:22.22.0-bookworm-slim AS app
WORKDIR /app
COPY --from=workspace /workspace/apps/web/.next/standalone ./
COPY --from=workspace /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=workspace /workspace/packages /workspace/packages
COPY --from=workspace /workspace/apps/web/lib /workspace/apps/web/lib
COPY --from=workspace /workspace/apps/web/scripts /workspace/apps/web/scripts
COPY --from=workspace /workspace/apps/web/package.json /workspace/apps/web/package.json
COPY --from=workspace /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/
COPY --from=prod-deps /workspace/node_modules /workspace/node_modules
COPY --from=prod-deps /workspace/apps/web/node_modules /workspace/apps/web/node_modules
COPY --from=prod-deps /workspace/apps/recorder/node_modules /workspace/apps/recorder/node_modules
COPY --from=orchestrator /out/orchestrator /app/orchestrator
COPY deploy/all-in-one/start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ORCHESTRATOR_INTERNAL_URL=http://127.0.0.1:8080 \
    ORCHESTRATOR_WS_UPSTREAM=http://127.0.0.1:8080 \
    RECORDER_UPSTREAM=http://127.0.0.1:8081
EXPOSE 3000

# Sin grabador: la UI de grabación responde 502 al no haber servicio en :8081.
FROM app AS slim
ENV K6FLOW_RECORDER=off
ENTRYPOINT ["/app/start.sh"]

# Con grabador. La base oficial de Playwright trae Chromium y sus dependencias de sistema ya
# resueltas (instalarlas con apt durante el build es lento y frágil); se borran los navegadores
# que la app no usa y se reemplaza Node 20 por el 22 que pide la app.
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS all-in-one
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY --from=node:22.22.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# La app sólo usa Chromium headless: fuera Firefox, WebKit, el Chromium con ventana y ffmpeg.
RUN rm -rf /ms-playwright/firefox* /ms-playwright/webkit* /ms-playwright/chromium-[0-9]* \
           /ms-playwright/ffmpeg* /usr/lib/node_modules /usr/local/lib/node_modules
WORKDIR /app
COPY --from=app /app /app
COPY --from=app /workspace /workspace
# Junto a apps/recorder para que resuelva playwright/ws desde su node_modules.
COPY --from=workspace /out/recorder.mjs /workspace/apps/recorder/recorder.mjs
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ORCHESTRATOR_INTERNAL_URL=http://127.0.0.1:8080 \
    ORCHESTRATOR_WS_UPSTREAM=http://127.0.0.1:8080 \
    RECORDER_UPSTREAM=http://127.0.0.1:8081
EXPOSE 3000
ENTRYPOINT ["/app/start.sh"]
