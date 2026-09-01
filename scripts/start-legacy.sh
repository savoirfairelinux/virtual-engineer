#!/usr/bin/env bash
# start-legacy.sh — Build images and start the legacy Docker orchestrator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

cd "$ROOT_DIR"
load_dotenv() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    [[ -n "${!key+x}" ]] && continue
    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && ( "${value:0:1}" == "'" && "${value: -1}" == "'" || "${value:0:1}" == '"' && "${value: -1}" == '"' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$env_file"
}
load_dotenv "$ROOT_DIR/.env"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' "Usage: ./scripts/start.sh [--help]" \
    "Default runtime: legacy Docker (set WORKSPACE_RUNTIME=openshell for OpenShell)."
  exit 0
fi
[[ "${1:-}" == "" ]] || error "Unknown argument: $1. Run ./scripts/start.sh --help"

SECRETS_DIR="${SECRETS_DIR:-$ROOT_DIR/secrets}"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
AGENT_NETWORK="${AGENT_DOCKER_NETWORK:-virtual-engineer_ve-agent-net}"

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

ensure_dir "$DATA_DIR" 755
ensure_dir "$SECRETS_DIR" 700
if ! docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network ${AGENT_NETWORK}..."
  docker network create --driver bridge "$AGENT_NETWORK" >/dev/null
fi

info "Building agent image..."
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
info "Building orchestrator image..."
docker build -f Dockerfile.orchestrator --build-arg INSTALL_OPENSHELL=false -t virtual-engineer:latest .

LATEST_ID=$(docker inspect --format='{{.Id}}' virtual-engineer:latest 2>/dev/null || true)
RUNNING_ID=$(docker inspect --format='{{.Image}}' ve-orchestrator 2>/dev/null || true)
IS_RUNNING=$(docker inspect --format='{{.State.Running}}' ve-orchestrator 2>/dev/null || true)
if [[ "$IS_RUNNING" == "true" && "$RUNNING_ID" == "$LATEST_ID" ]]; then
  info "ve-orchestrator is already running the latest image — nothing to do."
  exit 0
fi
if [[ -n "$RUNNING_ID" ]]; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator >/dev/null
fi

SSH_AGENT_ARGS=()
if [[ -n "${SSH_AUTH_SOCK:-}" && -S "$SSH_AUTH_SOCK" ]]; then
  info "SSH agent detected at $SSH_AUTH_SOCK — forwarding into container."
  SSH_AGENT_ARGS=(-v "$SSH_AUTH_SOCK:$SSH_AUTH_SOCK" -e "SSH_AUTH_SOCK=$SSH_AUTH_SOCK")
else
  warn "No SSH agent socket found; agent-based SSH auth will not be available."
fi

info "Starting legacy Docker orchestrator..."
docker run -d \
  --name ve-orchestrator \
  --restart unless-stopped \
  --network host \
  --env-file "$ROOT_DIR/.env" \
  -e WORKSPACE_RUNTIME=legacy \
  -e AGENT_DOCKER_NETWORK="$AGENT_NETWORK" \
  -e DATABASE_PATH=/app/data/virtual-engineer.db \
  -e GH_CONFIG_DIR=/ve-gh \
  --security-opt label:disable \
  -v /etc/localtime:/etc/localtime:ro \
  -v "$DATA_DIR:/app/data:Z" \
  -v "$SECRETS_DIR:/app/secrets:ro,Z" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.config/gh:/ve-gh:ro" \
  --tmpfs /tmp/ve-review-diffs:rw,size=512m \
  "${SSH_AGENT_ARGS[@]}" \
  virtual-engineer:latest

info "ve-orchestrator started with the legacy Docker workspace runtime."
info "Admin UI : http://127.0.0.1:3100/admin"
info "Logs     : docker logs -f ve-orchestrator"
