#!/usr/bin/env bash
# Arranca la app completa dentro de un solo contenedor: migraciones + seed, orchestrator,
# grabador y web. Los tres servicios hablan por loopback; sólo el web se publica.
set -Eeuo pipefail

: "${DATABASE_URL:?Set DATABASE_URL (postgresql://user:password@db:5432/k6flow)}"

# El grabador y el web comparten token: el navegador lo recibe desde el build del frontend.
export RECORDER_AUTH_TOKEN="${RECORDER_AUTH_TOKEN:-dev-token}"
export ORCHESTRATOR_SERVICE_TOKEN="${ORCHESTRATOR_SERVICE_TOKEN:-k6flow-internal-token}"
export ORCHESTRATOR_INTERNAL_URL="http://127.0.0.1:8080"
export ORCHESTRATOR_WS_UPSTREAM="http://127.0.0.1:8080"
export RECORDER_UPSTREAM="http://127.0.0.1:8081"
export CAPTURE_DIR="${CAPTURE_DIR:-/var/lib/k6flow/captures}"
mkdir -p "$CAPTURE_DIR"

pids=()
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "Aplicando migraciones y usuario admin…"
node --experimental-strip-types /workspace/apps/web/scripts/release-setup.ts
echo "Base lista."

ORCHESTRATOR_ADDR="${ORCHESTRATOR_ADDR:-:8080}" /app/orchestrator &
pids+=($!)

(
  # El grabador escucha en 8081 y usa tsx: sus imports no llevan extensión y Node ESM los rechaza.
  cd /workspace/apps/recorder
  PORT="${RECORDER_PORT:-8081}" ./node_modules/.bin/tsx src/main.ts
) &
pids+=($!)

PORT="${PORT:-3000}" node /app/apps/web/server.js &
pids+=($!)

echo "K6Flow arriba: web :3000 · orchestrator :8080 · recorder :8081"
# Si cualquiera de los tres muere, el contenedor termina para que Docker lo reinicie.
wait -n "${pids[@]}"
echo "Un servicio de K6Flow terminó; reiniciando el contenedor." >&2
exit 1
