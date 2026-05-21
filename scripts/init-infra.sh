#!/usr/bin/env bash
# init-infra.sh — Prepare host directories + generate SSH keys for Virtual Engineer
#
# Run this BEFORE "start-orchestrator.sh" to ensure all bind-mounted directories
# are owned by the current user. If Docker creates them first it does so as
# root, making them read-only for the user.
#
# The SSH public key must be manually added to the virtual-engineer account
# in your Gerrit instance.
#
# Usage:
#   ./scripts/init-infra.sh
#
# Optional environment variables:
#   VE_USER        (default: virtual-engineer)
#   VE_EMAIL       (default: virtual-engineer@localhost)
#   SECRETS_DIR    (default: ./secrets)
#   DATA_DIR       (default: ./data)

set -euo pipefail

VE_USER="${VE_USER:-virtual-engineer}"
VE_EMAIL="${VE_EMAIL:-virtual-engineer@localhost}"
SECRETS_DIR="${SECRETS_DIR:-./secrets}"
DATA_DIR="${DATA_DIR:-./data}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }

# Ensure a directory exists and is owned by the current user.
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
  info "✓ ${dir} — owner=$(id -un) perms=${perms}"
}

# ─── Pre-create all Docker bind-mounted host directories ──────────────────────
# Must run BEFORE "start-orchestrator.sh" to avoid Docker creating them as root.

ensure_dir "$DATA_DIR"    755   # SQLite database (rw inside container)
ensure_dir "$SECRETS_DIR" 700   # SSH keys (ro inside container; 700 = owner only)

# ─── Generate SSH key ─────────────────────────────────────────────────────────
if [[ ! -f "${SECRETS_DIR}/gerrit_id_ed25519" ]]; then
  info "Generating SSH key for virtual-engineer..."
  ssh-keygen -t ed25519 \
    -C "virtual-engineer@localhost" \
    -f "${SECRETS_DIR}/gerrit_id_ed25519" \
    -N ""
  chmod 600 "${SECRETS_DIR}/gerrit_id_ed25519"
  info "✓ SSH key generated at ${SECRETS_DIR}/gerrit_id_ed25519"
else
  info "✓ SSH key already exists at ${SECRETS_DIR}/gerrit_id_ed25519"
fi

# ─── Create agent workspace directory on the host ─────────────────────────────
# Docker bind-mounts the workspace dir into the orchestrator AND into each
# ephemeral agent container. The directory must be writable by non-root
# container processes, so we create it with sticky-dir permissions (1777).

WORKSPACES_DIR="/tmp/ve-workspaces"
if [[ ! -d "$WORKSPACES_DIR" ]]; then
  info "Creating agent workspace directory at ${WORKSPACES_DIR}..."
  mkdir -p "$WORKSPACES_DIR"
  chmod 1777 "$WORKSPACES_DIR"
  info "✓ Workspace directory created: ${WORKSPACES_DIR}"
else
  # Ensure permissions are correct even if the directory already exists.
  chmod 1777 "$WORKSPACES_DIR"
  info "✓ Workspace directory already exists: ${WORKSPACES_DIR}"
fi

# ─── Create agent Docker network ──────────────────────────────────────────────
# Agent containers are placed on this isolated bridge network.
# Must exist before the orchestrator spawns its first agent cycle.
AGENT_NETWORK="virtual-engineer_ve-agent-net"
if ! docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network ${AGENT_NETWORK}..."
  docker network create --driver bridge "$AGENT_NETWORK"
  info "✓ Docker network created: ${AGENT_NETWORK}"
else
  info "✓ Docker network already exists: ${AGENT_NETWORK}"
fi

# ─── Display next steps ────────────────────────────────────────────────────────

PUBLIC_KEY_PATH="${SECRETS_DIR}/gerrit_id_ed25519.pub"
PUBLIC_KEY=$(cat "$PUBLIC_KEY_PATH")

info ""
info "╔══════════════════════════════════════════════════════════════════╗"
info "║                    SSH Keys Generated                           ║"
info "║                                                                  ║"
info "║  Private key: ${SECRETS_DIR}/gerrit_id_ed25519                  ║"
info "║  Public key:  ${PUBLIC_KEY_PATH}                               ║"
info "║                                                                  ║"
info "║  Next steps (manual):                                            ║"
info "║  1. Create the 'virtual-engineer' account in Gerrit             ║"
info "║  2. Add the SSH public key to the account:                      ║"
info "║                                                                  ║"
info "║     Public key content:                                          ║"
info "║     ────────────────────────────────────────────────────────    ║"
info "║     ${PUBLIC_KEY}                                               ║"
info "║     ────────────────────────────────────────────────────────    ║"
info "║                                                                  ║"
info "║  3. Configure Virtual Engineer with your Gerrit/Redmine URLs  ║"
info "║                                                                  ║"
info "╚══════════════════════════════════════════════════════════════════╝"
