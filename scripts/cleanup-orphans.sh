#!/bin/bash
# K6F9-08: Cleanup orphaned K6 containers and resources
# Run periodically (e.g., via cron) or after crashes

set -e

echo "=== K6Flow Orphan Cleanup ==="
echo "Timestamp: $(date -Iseconds)"

# 1. Find and remove orphaned K6 containers (managed by k6flow but stopped/dead)
echo ""
echo "Checking for orphaned K6 containers..."
ORPHAN_CONTAINERS=$(docker ps -a --filter "label=k6flow.managed=true" --filter "status=exited" --filter "status=dead" -q 2>/dev/null || true)

if [ -n "$ORPHAN_CONTAINERS" ]; then
    COUNT=$(echo "$ORPHAN_CONTAINERS" | wc -l)
    echo "Found $COUNT orphaned container(s). Removing..."
    echo "$ORPHAN_CONTAINERS" | xargs -r docker rm -f
    echo "Removed $COUNT container(s)."
else
    echo "No orphaned containers found."
fi

# 2. Clean up dangling images from K6 builds (if any)
echo ""
echo "Checking for dangling images..."
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null || true)
if [ -n "$DANGLING" ]; then
    COUNT=$(echo "$DANGLING" | wc -l)
    echo "Found $COUNT dangling image(s). Cleaning..."
    docker image prune -f > /dev/null
    echo "Cleaned dangling images."
else
    echo "No dangling images found."
fi

# 3. Show current k6flow-managed containers (for monitoring)
echo ""
echo "Currently running K6 containers:"
docker ps --filter "label=k6flow.managed=true" --format "table {{.ID}}\t{{.Status}}\t{{.Names}}" 2>/dev/null || echo "(none)"

# 4. Show disk usage summary
echo ""
echo "Docker disk usage:"
docker system df --format "table {{.Type}}\t{{.Size}}\t{{.Reclaimable}}"

echo ""
echo "=== Cleanup complete ==="
