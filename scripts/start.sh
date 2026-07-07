#!/usr/bin/env bash
# start.sh — Build images and start the Virtual Engineer orchestrator container.
#             Skips the container restart if it is already running the latest image.
#
# Usage:
#   ./scripts/start.sh
#
# Useful follow-up commands:
#   docker logs -f ve-orchestrator           # follow logs
#   docker stop ve-orchestrator              # graceful stop (keeps data)
#   docker rm -f ve-orchestrator             # force remove
#
# Optional environment variables:
#   SECRETS_DIR    (default: ./secrets)
#   DATA_DIR       (default: ./data)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info() { echo "[INFO]  $*"; }
warn() { echo "[WARN]  $*" >&2; }

cd "$ROOT_DIR"

SECRETS_DIR="${SECRETS_DIR:-$ROOT_DIR/secrets}"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"

# ─── Ensure a directory exists and is owned by the current user ───────────────
# If Docker already created it as root, reclaim ownership with sudo.
ensure_dir() {
  local dir="$1"
  local perms="${2:-755}"
  mkdir -p "$dir"
  if [[ "$(stat -c '%u' "$dir")" != "$(id -u)" ]]; then
    warn "${dir} is owned by root (Docker created it first). Fixing ownership..."
    sudo chown "$(id -u):$(id -g)" "$dir"
  fi
  chmod "$perms" "$dir"
}

ensure_dir "$DATA_DIR"    755
ensure_dir "$SECRETS_DIR" 700

# ─── Agent workspace directory ────────────────────────────────────────────────
WORKSPACES_DIR="/tmp/ve-workspaces"
mkdir -p "$WORKSPACES_DIR"
chmod 1777 "$WORKSPACES_DIR"

# ─── Agent Docker network ─────────────────────────────────────────────────────
AGENT_NETWORK="virtual-engineer_ve-agent-net"
if ! docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network ${AGENT_NETWORK}..."
  docker network create --driver bridge "$AGENT_NETWORK"
fi

info "Building agent image..."
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .

info "Building orchestrator image..."
docker build -f Dockerfile.orchestrator -t virtual-engineer:latest .

# ─── Idempotent container restart ─────────────────────────────────────────────
# Skip restart if the container is already running the image we just built.
LATEST_ID=$(docker inspect --format='{{.Id}}' virtual-engineer:latest 2>/dev/null || true)
RUNNING_ID=$(docker inspect --format='{{.Image}}' ve-orchestrator 2>/dev/null || true)
IS_RUNNING=$(docker inspect --format='{{.State.Running}}' ve-orchestrator 2>/dev/null || true)

if [[ "$IS_RUNNING" == "true" && "$RUNNING_ID" == "$LATEST_ID" ]]; then
  info "ve-orchestrator is already running the latest image — nothing to do."
  info "Logs : docker logs -f ve-orchestrator"
  exit 0
fi

if [[ -n "$RUNNING_ID" ]]; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator
fi

info "Starting ve-orchestrator..."

# Forward SSH agent socket into the container using the same host path so that
# nested Docker containers spawned by the orchestrator can reach it too (same-path trick).
SSH_AGENT_ARGS=""
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
  info "SSH agent detected at $SSH_AUTH_SOCK — forwarding into container."
  SSH_AGENT_ARGS="-v $SSH_AUTH_SOCK:$SSH_AUTH_SOCK -e SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
else
  warn "No SSH agent socket found (SSH_AUTH_SOCK not set or not a socket). Agent-based SSH auth will not be available."
fi

# shellcheck disable=SC2086 — intentional word-splitting for SSH_AGENT_ARGS
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
  $SSH_AGENT_ARGS \
  virtual-engineer:latest

info "ve-orchestrator started."
info "Admin UI : http://127.0.0.1:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"
