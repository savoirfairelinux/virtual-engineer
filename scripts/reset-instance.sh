#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFRESH_ENV=0

info() {
  echo "[INFO]  $*"
}

warn() {
  echo "[WARN]  $*" >&2
}

usage() {
  cat <<'EOF'
Usage: ./scripts/reset-instance.sh [--refresh-env]

Resets the local Virtual Engineer instance state without touching versioned
files. This removes the local SQLite database, generated Gerrit SSH keys, and
build/test artifacts.

Options:
  --refresh-env  Recreate .env from .env.example after cleanup
  -h, --help     Show this help message
EOF
}

read_env_value() {
  local source_file="$1"
  local key="$2"

  [[ -f "$source_file" ]] || return 1

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^\"|\"$/, "", value)
      gsub(/^\047|\047$/, "", value)
      print value
      exit
    }
  ' "$source_file"
}

remove_path() {
  local path="$1"

  if [[ -e "$path" ]]; then
    rm -rf "$path"
    info "Removed $path"
  else
    info "Skipped $path (not present)"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --refresh-env)
      REFRESH_ENV=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      warn "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

cd "$ROOT_DIR"

info "Resetting local Virtual Engineer instance state"

if command -v docker >/dev/null 2>&1; then
  if docker inspect ve-orchestrator >/dev/null 2>&1; then
    if docker rm -f ve-orchestrator >/dev/null 2>&1; then
      info "Stopped and removed ve-orchestrator container"
    else
      warn "Could not remove ve-orchestrator container; continuing cleanup"
    fi
  fi
  # Also uninstall the OpenShell gateway Helm release if it was deployed by start.sh.
  HELM_BIN=""
  for _h in "$HOME/.local/bin/helm" /usr/local/bin/helm /usr/bin/helm; do
    if [[ -x "$_h" ]]; then HELM_BIN="$_h"; break; fi
  done
  if [[ -n "$HELM_BIN" ]] && KUBECONFIG="${K3S_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}" "$HELM_BIN" status openshell -n virtual-engineer >/dev/null 2>&1; then
    info "Uninstalling OpenShell gateway Helm release..."
    KUBECONFIG="${K3S_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}" "$HELM_BIN" uninstall openshell -n virtual-engineer 2>/dev/null || \
      warn "Could not uninstall Helm release; continuing cleanup"
  fi
  # Compatibility: also remove legacy Docker gateway container if present.
  if docker inspect ve-openshell-gateway >/dev/null 2>&1; then
    docker rm -f ve-openshell-gateway >/dev/null 2>&1 || true
  fi
else
  warn "docker is not installed; skipping container shutdown"
fi

DATABASE_PATH="$(read_env_value .env DATABASE_PATH || true)"
if [[ -z "$DATABASE_PATH" ]]; then
  DATABASE_PATH="$(read_env_value .env.example DATABASE_PATH || true)"
fi
if [[ -z "$DATABASE_PATH" ]]; then
  DATABASE_PATH="./data/virtual-engineer.db"
fi

remove_path "$DATABASE_PATH"
remove_path "${DATABASE_PATH}-wal"
remove_path "${DATABASE_PATH}-shm"
remove_path "./coverage"
remove_path "./test-results"
remove_path "./dist"

if [[ "$REFRESH_ENV" -eq 1 ]]; then
  cp .env.example .env
  info "Recreated .env from .env.example"
else
  if [[ -f .env ]]; then
    warn ".env left unchanged. Re-run with --refresh-env to replace it from .env.example."
  else
    info "No .env present. Re-run with --refresh-env to create one from .env.example."
  fi
fi

info "Reset complete"
info "Next: update .env for the new external instance, then follow the README bootstrap steps"
