#!/usr/bin/env bash
# Guards the published compose file: it must resolve to pull-only images, so a
# user can run it without cloning the repository.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

compose_file="deploy/docker-compose.release.yml"
[[ -f $compose_file ]] || { echo "Missing $compose_file" >&2; exit 1; }

# A build context here would mean the published flow silently requires the repo.
if grep -qE '^\s*build:' "$compose_file"; then
  echo "$compose_file must not build images; it is the pull-only release stack" >&2
  exit 1
fi

for expected in k6flow-web k6flow-orchestrator k6flow-recorder k6flow-setup; do
  grep -q "k6flow-${expected#k6flow-}" "$compose_file" || {
    echo "$compose_file does not reference the $expected image" >&2
    exit 1
  }
done

# The configuration must resolve with only the variables a user is asked for.
POSTGRES_PASSWORD=ci-dummy-password ADMIN_PASSWORD=ci-dummy-password \
  docker compose -f "$compose_file" config --quiet

# Pinning a version must reach every published image.
if ! K6FLOW_VERSION=9.9.9 POSTGRES_PASSWORD=ci-dummy-password ADMIN_PASSWORD=ci-dummy-password \
  docker compose -f "$compose_file" config 2>/dev/null | grep -q 'image: .*:9\.9\.9'; then
  echo "K6FLOW_VERSION is not applied to the published images" >&2
  exit 1
fi
if K6FLOW_VERSION=9.9.9 POSTGRES_PASSWORD=ci-dummy-password ADMIN_PASSWORD=ci-dummy-password \
  docker compose -f "$compose_file" config 2>/dev/null | grep -q 'image: .*:latest'; then
  echo "K6FLOW_VERSION=9.9.9 must not leave any image on :latest" >&2
  exit 1
fi

echo "Release compose is pull-only and honours K6FLOW_VERSION."
