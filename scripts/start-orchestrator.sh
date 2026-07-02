#!/usr/bin/env bash
# start-orchestrator.sh — Build and (re)start the Virtual Engineer orchestrator container.
#
# Run ./scripts/init-infra.sh once before the first invocation to pre-create
# data/, secrets/, and the virtual-engineer_ve-agent-net bridge network.
#
# Usage:
#   ./scripts/start-orchestrator.sh          # build + start
#
# Useful follow-up commands:
#   docker logs -f ve-orchestrator           # follow logs
#   docker stop ve-orchestrator              # graceful stop (keeps data)
#   docker rm -f ve-orchestrator             # force remove

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info() { echo "[INFO]  $*"; }
warn() { echo "[WARN]  $*" >&2; }

cd "$ROOT_DIR"

info "Building agent image..."
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .

info "Building orchestrator image..."
docker build -f Dockerfile.orchestrator -t virtual-engineer:latest .

# Stop and remove the existing container before recreating.
if docker inspect ve-orchestrator >/dev/null 2>&1; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator
fi

info "Starting ve-orchestrator..."
docker run -d \
  --name ve-orchestrator \
  --restart unless-stopped \
  --network host \
  --env-file "$ROOT_DIR/.env" \
  -e DATABASE_PATH=/app/data/virtual-engineer.db \
  -e GH_CONFIG_DIR=/ve-gh \
  --security-opt label:disable \
  -v /etc/localtime:/etc/localtime:ro \
  -v "$ROOT_DIR/data:/app/data:Z" \
  -v "$ROOT_DIR/secrets:/app/secrets:ro,Z" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.config/gh:/ve-gh:ro" \
  --tmpfs /tmp/ve-review-diffs:rw,size=512m \
  virtual-engineer:latest

info "ve-orchestrator started."
info "Admin UI : http://0.0.0.0:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"
