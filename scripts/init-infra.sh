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

# ─── Generate SSH key (optional — skip if you prefer SSH agent or UI-generated keys) ──
# This creates a dedicated ed25519 key for Virtual Engineer at a known path.
# Alternatives that do NOT require this step:
#   • SSH Agent mode — forward your system SSH agent by keeping SSH_AUTH_SOCK set when running
#     start-orchestrator.sh; the orchestrator will mount the socket automatically.
#   • UI-generated key — open the Admin UI → Integrations → edit a Gerrit integration and click
#     "Generate key" in the SSH Authentication section.
if [[ ! -f "${SECRETS_DIR}/gerrit_id_ed25519" ]]; then
  info "Generating SSH key for virtual-engineer (skip with Ctrl-C if using SSH agent or UI key gen)..."
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
if [[ -f "$PUBLIC_KEY_PATH" ]]; then
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
else
  info ""
  info "╔══════════════════════════════════════════════════════════════════╗"
  info "║                    Infrastructure Ready                         ║"
  info "║                                                                  ║"
  info "║  No file-based SSH key was generated.  Choose one of:           ║"
  info "║                                                                  ║"
  info "║  Option A — SSH Agent (recommended):                            ║"
  info "║    Keep SSH_AUTH_SOCK set when running start-orchestrator.sh.   ║"
  info "║    The orchestrator will forward the agent socket automatically. ║"
  info "║                                                                  ║"
  info "║  Option B — UI-generated key:                                   ║"
  info "║    Admin UI → Integrations → edit Gerrit → SSH Authentication   ║"
  info "║    → 'Generated key' → click 'Generate key' → copy public key  ║"
  info "║    → add it to Gerrit → Settings → SSH Keys.                    ║"
  info "║                                                                  ║"
  info "║  Option C — Custom path (legacy):                               ║"
  info "║    Re-run init-infra.sh without Ctrl-C to generate a key, then  ║"
  info "║    set 'Custom path' in the integration's SSH Authentication     ║"
  info "║    section.                                                      ║"
  info "║                                                                  ║"
  info "╚══════════════════════════════════════════════════════════════════╝"
fi
