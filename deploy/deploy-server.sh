#!/usr/bin/env bash
# Runs on the VPS (piped over SSH by the GitHub Actions workflow).
# Pulls the given backend image, swaps the container, and rolls back to the
# previous image if the new one doesn't pass the health check.
#
# Usage: deploy-server.sh <image:tag>
set -euo pipefail

IMAGE="${1:?Usage: deploy-server.sh <image:tag>}"
NAME="product-agent-server"
ENV_FILE="/opt/product-agent/server.env"   # secrets: OPENAI / QDRANT / MONGO keys (created once by hand)
PORT=3001

run_container() {
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    --init \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    -e HOST=0.0.0.0 \
    -e PORT="$PORT" \
    -e TRUST_PROXY=true \
    -v product-agent-logs:/app/backend/logs \
    -p "127.0.0.1:${PORT}:${PORT}" \
    --memory 512m \
    "$1" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

[ -f "$ENV_FILE" ] || { echo "❌ Missing $ENV_FILE"; exit 1; }

# Port 3001 must be free or held by this app's own container (which we're about to replace)
if ss -ltnH "( sport = :${PORT} )" | grep -q . && ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "❌ Port ${PORT} is used by another process on this server:"
  ss -ltnp "( sport = :${PORT} )" || true
  exit 1
fi

echo "🔄 Pulling $IMAGE"
docker pull "$IMAGE"

PREVIOUS_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)"

echo "🛑 Replacing container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
run_container "$IMAGE"

if wait_healthy; then
  echo "✅ $IMAGE is healthy"
  curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo
else
  echo "❌ New container failed the health check. Logs:"
  docker logs --tail 50 "$NAME" || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -n "$PREVIOUS_IMAGE" ]; then
    echo "↩️  Rolling back to $PREVIOUS_IMAGE"
    run_container "$PREVIOUS_IMAGE"
    wait_healthy && echo "✅ Rollback healthy" || echo "❌ Rollback also unhealthy"
  fi
  exit 1
fi

echo "🧹 Removing old images of this app"
REPO="${IMAGE%:*}"
docker images "$REPO" --format '{{.Repository}}:{{.Tag}}' \
  | grep -vxF "$IMAGE" | grep -v ':latest$' \
  | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null
