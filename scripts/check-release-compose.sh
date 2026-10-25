#!/usr/bin/env bash
# Guards the published compose file: it must resolve to pull-only images, so a
# user can run it without cloning the repository.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

compose_file="deploy/docker-compose.release.yml"
all_in_one_file="deploy/docker-compose.all-in-one.yml"
for file in "$compose_file" "$all_in_one_file"; do
  [[ -f $file ]] || { echo "Missing $file" >&2; exit 1; }
  # A build context here would mean the published flow silently requires the repo.
  if grep -qE '^\s*build:' "$file"; then
    echo "$file must not build images; it is a pull-only stack" >&2
    exit 1
  fi
done

for expected in k6flow-web k6flow-orchestrator k6flow-recorder k6flow-setup; do
  grep -q "k6flow-${expected#k6flow-}" "$compose_file" || {
    echo "$compose_file does not reference the $expected image" >&2
    exit 1
  }
done

# El stack todo en uno usa una única imagen de la app.
grep -q 'image: ghcr.io/jereok91/\${K6FLOW_IMAGE:-k6flow}:\${K6FLOW_VERSION:-latest}' "$all_in_one_file" || {
  echo "$all_in_one_file must reference the all-in-one image ghcr.io/jereok91/k6flow" >&2
  exit 1
}

# The configuration must resolve with only the variables a user is asked for.
POSTGRES_PASSWORD=ci-dummy-password ADMIN_PASSWORD=ci-dummy-password \
  docker compose -f "$compose_file" config --quiet
POSTGRES_PASSWORD=ci-dummy-password ADMIN_PASSWORD=ci-dummy-password \
  docker compose -f "$all_in_one_file" config --quiet

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

echo "Release composes are pull-only and honour K6FLOW_VERSION."
