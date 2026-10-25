#!/usr/bin/env bash
# Disposable integration boundary; never targets the developer's Compose project.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for tool in docker timeout curl node; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
# Bound inspection and probe operations too; startup/cleanup have separate budgets.
docker() { timeout --foreground 60 docker "$@"; }
docker version >/dev/null
docker compose version

suffix="$(date +%s)-$$-${RANDOM}"
projects=()
active_project=""
active_files=()
compose() {
  WEB_PORT=0 docker compose --env-file deploy/.env.example \
    --project-name "$active_project" "${active_files[@]}" "$@"
}
cleanup() {
  local result=$? project service image image_ids
  trap - EXIT INT TERM
  for project in "${projects[@]}"; do
    # Each project was checked empty before startup and added before resource creation.
    if ! WEB_PORT=0 timeout --foreground 60 docker compose \
      --env-file deploy/.env.example --project-name "$project" \
      -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
      down --volumes --timeout 10; then
      echo "Cleanup failed for owned project $project; inspect its labeled resources." >&2
      result=1
    fi
    for service in web orchestrator recorder; do
      image="$project-$service:latest"
      if ! image_ids=$(docker image ls -q "$image"); then
        echo "Cannot inspect owned image $image for cleanup" >&2
        result=1
      elif [[ -n $image_ids ]]; then
        # Exact owned tags only; do not prune shared base or intermediate layers.
        if ! docker image rm --no-prune "$image"; then
          echo "Cleanup failed for owned image $image" >&2
          result=1
        fi
      fi
    done
  done
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_stack() {
  local mode=$1 id port service state bindings target started remaining resources
  active_project="k6flow-check-${suffix}-${mode}"
  active_files=(-f deploy/docker-compose.yml)
  if [[ $mode == dev ]]; then
    active_files+=(-f deploy/docker-compose.dev.yml)
  fi
  # Refuse any collision rather than adopting or deleting existing resources.
  for kind in container network volume; do
    resources=$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$active_project") || return 1
    if [[ -n $resources ]]; then
      echo "Project collision: $active_project" >&2
      return 1
    fi
  done
  for service in web orchestrator recorder; do
    resources=$(docker image ls -q "$active_project-$service") || return 1
    if [[ -n $resources ]]; then
      echo "Image collision: $active_project-$service" >&2
      return 1
    fi
  done
  compose config --quiet
  projects+=("$active_project")
  echo "Starting $mode stack ($active_project); startup budget 900s."
  target=production
  [[ $mode != dev ]] || target=development
  started=$SECONDS
  # --force-rm also removes failed classic-builder intermediate containers.
  for service in web orchestrator; do
    remaining=$((900 - SECONDS + started))
    [[ $remaining -gt 0 ]] || { echo "Startup budget exhausted" >&2; return 1; }
    timeout --foreground "$remaining" docker build --force-rm \
      --target "$target" --tag "$active_project-$service" \
      --file "apps/$service/Dockerfile" .
  done
  # The recorder has a single-stage Dockerfile and is started with --no-build.
  remaining=$((900 - SECONDS + started))
  [[ $remaining -gt 0 ]] || { echo "Startup budget exhausted" >&2; return 1; }
  timeout --foreground "$remaining" docker build --force-rm \
    --tag "$active_project-recorder" \
    --file apps/recorder/Dockerfile .
  remaining=$((900 - SECONDS + started))
  [[ $remaining -gt 0 ]] || { echo "Startup budget exhausted" >&2; return 1; }
  if ! WEB_PORT=0 timeout --foreground "$remaining" docker compose \
    --env-file deploy/.env.example --project-name "$active_project" \
    "${active_files[@]}" up --no-build --detach --wait --wait-timeout 180; then
    compose ps
    compose logs --tail 40
    return 1
  fi
  for service in web orchestrator db recorder; do
    id=$(compose ps -q "$service")
    [[ -n $id ]] || { echo "Missing $service" >&2; return 1; }
    state=$(docker inspect --format '{{.State.Health.Status}}' "$id")
    [[ $state == healthy ]] || { echo "$service is $state" >&2; return 1; }
    if [[ $service != web ]]; then
      bindings=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$id")
      # Dev only (authorized 2026-10-21): orchestrator may bind exactly loopback 8080.
      if [[ $mode == dev && $service == orchestrator &&
            $bindings == '{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]}' ]]; then
        continue
      fi
      # Dev only: the recorder may bind exactly loopback 8081 for direct WS access.
      if [[ $mode == dev && $service == recorder &&
            $bindings == '{"8081/tcp":[{"HostIp":"127.0.0.1","HostPort":"8081"}]}' ]]; then
        continue
      fi
      [[ $bindings == '{}' || $bindings == null ]] || {
        echo "$service unexpectedly publishes ports: $bindings" >&2; return 1;
      }
    fi
  done
  port=$(compose port web 3000)
  curl --fail --silent --show-error --max-time 10 "http://$port/api/healthz" |
    node -e 'let b=""; process.stdin.on("data", c => b+=c); process.stdin.on("end", () => { const j=JSON.parse(b); if (j.status!=="ok" || Object.keys(j).length!==1) process.exit(1); });'
  # Separate client process on the shared network: no host Go port is needed.
  compose exec -T web node -e \
    'fetch("http://orchestrator:8080/healthz", {signal: AbortSignal.timeout(10000)}).then(async r => { const j=await r.json(); if (!r.ok || j.status!=="ok" || Object.keys(j).length!==1) process.exit(1); }).catch(e => { console.error(e); process.exit(1); })'
  echo "$mode: four healthy services, external web/internal Go probes passed, only the documented dev loopback ports are published."
}

run_stack production
run_stack dev
# EXIT cleanup is part of acceptance; cleanup failure changes the exit code.
echo "Both runtime scenarios passed; cleaning only disposable project resources."
