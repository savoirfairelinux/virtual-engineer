#!/usr/bin/env bash
# start.sh — Build images and start the Virtual Engineer orchestrator container.
#             Skips the container restart if it is already running the latest image.
#
# Usage:
#   ./scripts/start.sh                   # Docker runtime (default)
#   ./scripts/start.sh --openshell       # OpenShell runtime:
#                                        #   1. starts the OpenShell gateway container
#                                        #   2. builds the orchestrator image with the pinned CLI
#                                        #   3. wires the gateway address into the orchestrator
#                                        #   4. sets the default runtime to openshell in the DB
#   ./scripts/start.sh --openshell-version v0.0.79   # pin a specific version
#
# Optional environment variables:
#   SECRETS_DIR    (default: ./secrets)
#   DATA_DIR       (default: ./data)
#   OPENSHELL_VERSION  (default: v0.0.79)  override when not using --openshell-version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

cd "$ROOT_DIR"

# ─── Parse arguments ──────────────────────────────────────────────────────────
OPENSHELL=false
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.79}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openshell)
      OPENSHELL=true; shift ;;
    --openshell-version)
      [[ -n "${2:-}" ]] || error "--openshell-version requires a value (e.g. v0.0.79)"
      OPENSHELL_VERSION="$2"; OPENSHELL=true; shift 2 ;;
    --help|-h)
      sed -n '2,18p' "$0"; exit 0 ;;
    *)
      error "Unknown argument: $1. Run ./scripts/start.sh --help" ;;
  esac
done

SECRETS_DIR="${SECRETS_DIR:-$ROOT_DIR/secrets}"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"

# ─── Ensure a directory exists and is owned by the current user ───────────────
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

# ─── Agent Docker network ─────────────────────────────────────────────────────
AGENT_NETWORK="virtual-engineer_ve-agent-net"
if ! docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network ${AGENT_NETWORK}..."
  docker network create --driver bridge "$AGENT_NETWORK"
fi

info "Building agent image..."
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .

# ─── Orchestrator image (with or without OpenShell CLI) ───────────────────────
if [[ "$OPENSHELL" == "true" ]]; then
  info "Building orchestrator image with OpenShell CLI (${OPENSHELL_VERSION})..."
  docker build -f Dockerfile.orchestrator \
    --build-arg INSTALL_OPENSHELL=true \
    --build-arg OPENSHELL_VERSION="$OPENSHELL_VERSION" \
    -t virtual-engineer:latest .
else
  info "Building orchestrator image (Docker runtime only)..."
  docker build -f Dockerfile.orchestrator -t virtual-engineer:latest .
fi

# ─── Idempotent container restart ─────────────────────────────────────────────
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

# ─── OpenShell gateway (local Docker mode, started before the orchestrator) ───
OPENSHELL_GATEWAY_ARGS=""
if [[ "$OPENSHELL" == "true" ]]; then
  OPENSHELL_GW_CONTAINER="ve-openshell-gateway"
  # The gateway listens on 8080; we bind it to 127.0.0.1 (host-only).
  # The orchestrator uses --network host so it reaches 127.0.0.1:8080 directly.
  OPENSHELL_GW_PORT=8080
  OPENSHELL_GATEWAY_URL="http://127.0.0.1:${OPENSHELL_GW_PORT}"

  # The gateway image only publishes 'latest' and commit-SHA tags on GHCR —
  # there are no semver/vX.Y.Z image tags. OPENSHELL_VERSION only applies to
  # the CLI binary baked into the orchestrator image.
  OPENSHELL_GW_IMAGE="ghcr.io/nvidia/openshell/gateway:latest"

  GW_RUNNING=$(docker inspect --format='{{.State.Running}}' "$OPENSHELL_GW_CONTAINER" 2>/dev/null || echo "false")
  if [[ "$GW_RUNNING" == "true" ]]; then
    info "OpenShell gateway already running."
  else
    # Remove a stopped gateway container if it exists.
    docker rm -f "$OPENSHELL_GW_CONTAINER" 2>/dev/null || true

    info "Starting OpenShell gateway (${OPENSHELL_GW_IMAGE})..."
    docker pull "$OPENSHELL_GW_IMAGE" || \
      error "Could not pull OpenShell gateway image. Check connectivity or run: docker pull ${OPENSHELL_GW_IMAGE}"

    docker run -d \
      --name "$OPENSHELL_GW_CONTAINER" \
      --restart unless-stopped \
      -p "127.0.0.1:${OPENSHELL_GW_PORT}:8080" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -e OPENSHELL_DRIVER=docker \
      -e OPENSHELL_TELEMETRY_ENABLED=false \
      "$OPENSHELL_GW_IMAGE"

    # Wait for the gateway to be ready.
    info "Waiting for OpenShell gateway to be ready..."
    GW_RETRIES=30
    until curl -sf "${OPENSHELL_GATEWAY_URL}/healthz" >/dev/null 2>&1 || \
          curl -sf "${OPENSHELL_GATEWAY_URL}/health"  >/dev/null 2>&1 || \
          [[ $GW_RETRIES -eq 0 ]]; do
      sleep 1; ((GW_RETRIES--))
    done
    if [[ $GW_RETRIES -eq 0 ]]; then
      warn "OpenShell gateway did not become healthy — sandbox creation will fail."
      warn "Check logs: docker logs $OPENSHELL_GW_CONTAINER"
    else
      info "OpenShell gateway is healthy at ${OPENSHELL_GATEWAY_URL}."
    fi
  fi

  # Pass the gateway address to the orchestrator so OpenShellClient uses it.
  OPENSHELL_GATEWAY_ARGS="-e OPENSHELL_GATEWAY=127.0.0.1:${OPENSHELL_GW_PORT}"
fi

SSH_AGENT_ARGS=""
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
  info "SSH agent detected at $SSH_AUTH_SOCK — forwarding into container."
  SSH_AGENT_ARGS="-v $SSH_AUTH_SOCK:$SSH_AUTH_SOCK -e SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
else
  warn "No SSH agent socket found (SSH_AUTH_SOCK not set or not a socket). Agent-based SSH auth will not be available."
fi

# shellcheck disable=SC2086 — intentional word-splitting for SSH_AGENT_ARGS / OPENSHELL_GATEWAY_ARGS
docker run -d \
  --name ve-orchestrator \
  --restart unless-stopped \
  --network host \
  --env-file "$ROOT_DIR/.env" \
  -e DATABASE_PATH=/app/data/virtual-engineer.db \
  -e GH_CONFIG_DIR=/ve-gh \
  --security-opt label:disable \
  -v /etc/localtime:/etc/localtime:ro \
  -v "$DATA_DIR:/app/data:Z" \
  -v "$SECRETS_DIR:/app/secrets:ro,Z" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.config/gh:/ve-gh:ro" \
  --tmpfs /tmp/ve-review-diffs:rw,size=512m \
  $SSH_AGENT_ARGS \
  $OPENSHELL_GATEWAY_ARGS \
  virtual-engineer:latest

info "ve-orchestrator started."
info "Admin UI : http://127.0.0.1:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"

# ─── Post-start: configure OpenShell as the default runtime in the DB ─────────
if [[ "$OPENSHELL" == "true" ]]; then
  info "Waiting for orchestrator to be ready..."
  RETRIES=20
  until curl -sf http://127.0.0.1:3100/health >/dev/null 2>&1 || [[ $RETRIES -eq 0 ]]; do
    sleep 1; ((RETRIES--))
  done

  if [[ $RETRIES -eq 0 ]]; then
    warn "Orchestrator did not become healthy in time. Set the default runtime manually:"
    warn "  Admin UI → Config → Runtime → select OpenShell → Save default"
  else
    # Derive the admin token from ADMIN_AUTH_SECRET in .env (same HMAC logic as the UI).
    ADMIN_SECRET=$(grep -E '^ADMIN_AUTH_SECRET=' "$ROOT_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    if [[ -z "$ADMIN_SECRET" ]]; then
      warn "ADMIN_AUTH_SECRET not found in .env — set the default runtime manually:"
      warn "  Admin UI → Config → Runtime → select OpenShell → Save default"
    else
      TS=$(date +%s)
      HMAC=$(echo -n "$TS" | openssl dgst -sha256 -hmac "$ADMIN_SECRET" -hex 2>/dev/null | awk '{print $NF}')
      TOKEN="${TS}.${HMAC}"
      HTTP=$(curl -sf -o /dev/null -w "%{http_code}" \
        -X PUT http://127.0.0.1:3100/api/admin/runtime \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TOKEN" \
        -d '{"defaultRuntime":"openshell"}' 2>/dev/null || echo "000")
      if [[ "$HTTP" == "200" ]]; then
        info "Default runtime set to openshell in the DB."
      else
        warn "Could not set default runtime via API (HTTP $HTTP). Set it manually:"
        warn "  Admin UI → Config → Runtime → select OpenShell → Save default"
      fi
    fi
  fi
fi

