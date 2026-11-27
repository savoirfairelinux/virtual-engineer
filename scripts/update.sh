#!/usr/bin/env bash
# update.sh — Update a scripts/start.sh deployment to a published release.
#
# Usage:
#   ./scripts/update.sh                      # update to the latest release
#   ./scripts/update.sh 0.4.0                # update to a specific release
#   ./scripts/update.sh --check              # print the running and latest versions
#   ./scripts/update.sh --install-service    # let System settings request updates (systemd, sudo)
#   ./scripts/update.sh --uninstall-service
#   ./scripts/update.sh --from-request       # run by the systemd service
#
# The release must have published images (.github/workflows/publish-images.yml).
# While the current version keeps running, the release tag is fetched and its
# images pulled. The orchestrator then stops gracefully: running agent cycles
# finish first, bounded by SHUTDOWN_DRAIN_TIMEOUT_MS. Next the database is backed
# up, the release tag checked out, and start.sh run with VE_IMAGE_TAG; the
# update succeeds once /health answers with the new version. On failure the
# database, .env, Git checkout and images are restored and the previous version
# restarted.
#
# Optional environment variables:
#   DATA_DIR                   (default: ./data)
#   VE_UPDATE_REMOTE           Git remote holding release tags (default: origin)
#   VE_UPDATE_HEALTH_TIMEOUT   seconds to wait for /health (default: 300)
#   VE_UPDATE_KEEP_BACKUPS     update backups to keep (default: 3)
#   VE_RELEASES_API            latest-release endpoint (default: GitHub API)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/start-lib.sh"
source "$SCRIPT_DIR/update-lib.sh"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }

ENV_FILE="$ROOT_DIR/.env"
RELEASES_API="${VE_RELEASES_API:-https://api.github.com/repos/savoirfairelinux/virtual-engineer/releases/latest}"
REMOTE="${VE_UPDATE_REMOTE:-origin}"
HEALTH_TIMEOUT="${VE_UPDATE_HEALTH_TIMEOUT:-300}"
KEEP_BACKUPS="${VE_UPDATE_KEEP_BACKUPS:-3}"
SERVICE_NAME="virtual-engineer-updater"

CURRENT_VERSION=""
TARGET_VERSION=""
STATUS_PATH=""

fail() {
  echo "[ERROR] $*" >&2
  if [[ -n "$STATUS_PATH" ]]; then
    write_update_status "$STATUS_PATH" failed "$CURRENT_VERSION" "$TARGET_VERSION" "$*" || true
  fi
  exit 1
}

set_status() {
  write_update_status "$STATUS_PATH" "$1" "$CURRENT_VERSION" "$TARGET_VERSION" "$2" \
    || warn "Could not write ${STATUS_PATH}."
  info "$2"
}

resolve_data_dir() {
  local data_dir
  data_dir=$(dotenv_value "$ENV_FILE" DATA_DIR)
  data_dir="${data_dir:-$ROOT_DIR/data}"
  [[ "$data_dir" == /* ]] || data_dir="$ROOT_DIR/$data_dir"
  mkdir -p "$data_dir"
  (cd "$data_dir" && pwd)
}

running_version() {
  local version
  version=$(docker inspect ve-orchestrator \
    --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)
  if [[ -z "$version" || "$version" == "unknown" ]]; then
    version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT_DIR/package.json" | head -n1)
  fi
  printf '%s\n' "$version"
}

latest_release() {
  local tag
  tag=$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "$RELEASES_API" | parse_release_tag) \
    || return 1
  normalize_release_version "$tag"
}

wait_for_health() {
  local url="$1" deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# ─── systemd service ─────────────────────────────────────────────────────────

install_service() {
  local data_dir="$1" units unit_dir="/etc/systemd/system" temporary_dir
  command -v systemctl >/dev/null 2>&1 || fail "systemd is required to let the admin UI request updates."
  units=$(updater_units "$ROOT_DIR" "$data_dir" "$(id -un)" "$(id -gn)" "$HOME" "$PATH") \
    || fail "Cannot generate the updater service."
  temporary_dir=$(mktemp -d)
  awk -v dir="$temporary_dir" '
    /^# --- / { file = dir "/" $3; next }
    { print > file }
  ' <<< "$units"
  info "Installing ${SERVICE_NAME}.path and ${SERVICE_NAME}.service (requires sudo)..."
  sudo install -m 644 "$temporary_dir/${SERVICE_NAME}.path" "$temporary_dir/${SERVICE_NAME}.service" "$unit_dir/"
  rm -rf "$temporary_dir"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}.path"
  {
    printf 'installed_at=%s\n' "$(date +%s)"
    printf 'unit=%s\n' "$SERVICE_NAME"
  } > "$data_dir/$UPDATER_INSTALLED_FILE"
  chmod 644 "$data_dir/$UPDATER_INSTALLED_FILE"
  info "Done. Configuration → System → Updates can now start updates."
}

uninstall_service() {
  local data_dir="$1"
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl disable --now "${SERVICE_NAME}.path" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.path" "/etc/systemd/system/${SERVICE_NAME}.service"
    sudo systemctl daemon-reload
  fi
  rm -f "$data_dir/$UPDATER_INSTALLED_FILE" "$data_dir/$UPDATE_REQUEST_FILE"
  info "Updater service removed."
}

# ─── Snapshot and rollback ───────────────────────────────────────────────────

BACKUP_DIR=""
PREVIOUS_REF=""
ROLLBACK_IMAGES=()

local_images() {
  local agent_base engine
  printf '%s\n' virtual-engineer:latest
  agent_base=$(dotenv_value "$ENV_FILE" AGENT_CONTAINER_IMAGE)
  agent_base="${agent_base:-virtual-engineer-workspace:latest}"
  [[ "$agent_base" == *@* ]] && return 0
  for engine in "${AGENT_ENGINE_CATALOG[@]}"; do
    agent_engine_image "$agent_base" "$engine"
  done
}

snapshot() {
  local data_dir="$1" image marker
  BACKUP_DIR="$data_dir/backups/update-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP_DIR/markers" || return 1
  chmod 700 "$data_dir/backups" "$BACKUP_DIR" || return 1
  PREVIOUS_REF=$(git -C "$ROOT_DIR" symbolic-ref -q --short HEAD || git -C "$ROOT_DIR" rev-parse HEAD) || return 1
  printf '%s\n' "$PREVIOUS_REF" > "$BACKUP_DIR/git-ref" || return 1
  cp -p "$ENV_FILE" "$BACKUP_DIR/env" || return 1
  for marker in "$data_dir"/.orchestrator-image-hash "$data_dir"/.orchestrator-run-config-hash \
      "$data_dir"/.agent-image-hash* "$data_dir"/agent-engines.installed "$data_dir"/agent-engines.forced; do
    if [[ -f "$marker" ]]; then cp -p "$marker" "$BACKUP_DIR/markers/" || return 1; fi
  done
  while IFS= read -r image; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      docker tag "$image" "$(rollback_image_tag "$image")" || return 1
      ROLLBACK_IMAGES+=("$image")
    fi
  done < <(local_images)
}

backup_database() {
  local data_dir="$1" suffix
  mkdir -p "$BACKUP_DIR/database"
  for suffix in "" -wal -shm; do
    if [[ -f "$data_dir/virtual-engineer.db${suffix}" ]]; then
      cp -p "$data_dir/virtual-engineer.db${suffix}" "$BACKUP_DIR/database/" || return 1
    fi
  done
}

restore_snapshot() {
  local data_dir="$1" suffix image marker
  for suffix in "" -wal -shm; do
    rm -f "$data_dir/virtual-engineer.db${suffix}" || return 1
    if [[ -f "$BACKUP_DIR/database/virtual-engineer.db${suffix}" ]]; then
      cp -p "$BACKUP_DIR/database/virtual-engineer.db${suffix}" "$data_dir/" || return 1
    fi
  done
  cp -p "$BACKUP_DIR/env" "$ENV_FILE" || return 1
  rm -f "$data_dir"/.orchestrator-image-hash "$data_dir"/.orchestrator-run-config-hash \
    "$data_dir"/.agent-image-hash* "$data_dir"/agent-engines.installed "$data_dir"/agent-engines.forced || return 1
  for marker in "$BACKUP_DIR"/markers/.[!.]* "$BACKUP_DIR"/markers/*; do
    if [[ -f "$marker" ]]; then cp -p "$marker" "$data_dir/" || return 1; fi
  done
  for image in "${ROLLBACK_IMAGES[@]}"; do
    docker tag "$(rollback_image_tag "$image")" "$image" || warn "Could not restore ${image}."
  done
  git -C "$ROOT_DIR" checkout --quiet "$PREVIOUS_REF" || return 1
}

rollback() {
  local data_dir="$1" reason="$2" url="$3"
  set_status rolling_back "${reason} Restoring ${CURRENT_VERSION}..."
  docker rm -f ve-orchestrator >/dev/null 2>&1 || true
  if ! restore_snapshot "$data_dir"; then
    fail "${reason} Restoring the snapshot in ${BACKUP_DIR} also failed; see ${data_dir}/update.log."
  fi
  if (cd "$ROOT_DIR" && env -u VE_IMAGE_TAG ./scripts/start.sh) && wait_for_health "$url"; then
    set_status rolled_back "${reason} Restored ${CURRENT_VERSION}; the database was reset to its pre-update backup."
    exit 1
  fi
  fail "${reason} The rollback to ${CURRENT_VERSION} did not come up either; the backup is in ${BACKUP_DIR}."
}

# ─── Update ──────────────────────────────────────────────────────────────────

prefetch_images() {
  local orchestrator_repo agent_repo agent_base engines engine image
  local -a images
  orchestrator_repo=$(dotenv_value "$ENV_FILE" VE_IMAGE_REPO)
  agent_repo=$(dotenv_value "$ENV_FILE" VE_AGENT_IMAGE_REPO)
  agent_base=$(dotenv_value "$ENV_FILE" AGENT_CONTAINER_IMAGE)
  orchestrator_repo="${orchestrator_repo:-$DEFAULT_VE_IMAGE_REPO}"
  agent_repo="${agent_repo:-$DEFAULT_VE_AGENT_IMAGE_REPO}"
  images=("${orchestrator_repo}:${TARGET_VERSION}")
  # start.sh leaves digest-pinned agent images to the operator.
  if [[ "$agent_base" != *@* ]]; then
    engines=$(resolve_agent_engines "$1" "$(dotenv_value "$ENV_FILE" AGENT_ENGINES)") || return 1
    for engine in $engines; do
      images+=("$(agent_engine_image "${agent_repo}:${TARGET_VERSION}" "$engine")")
    done
  fi
  for image in "${images[@]}"; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      info "Pulling ${image}..."
      docker pull "$image" >/dev/null || return 1
    fi
  done
}

# A systemd service has no login SSH agent; reuse the one the running
# orchestrator was started with while its socket still exists.
adopt_orchestrator_ssh_agent() {
  local socket
  [[ -z "${SSH_AUTH_SOCK:-}" ]] || return 0
  socket=$(docker inspect ve-orchestrator --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^SSH_AUTH_SOCK=//p' | head -n1)
  if [[ -n "$socket" && -S "$socket" ]]; then
    export SSH_AUTH_SOCK="$socket"
  fi
  return 0
}

run_update() {
  local data_dir="$1" host port url drain stop_timeout running_label

  [[ -f "$ENV_FILE" ]] || fail "Missing ${ENV_FILE}; run ./scripts/start.sh once first."
  git -C "$ROOT_DIR" diff --quiet HEAD -- \
    || fail "The checkout has local changes to tracked files; commit or stash them first."
  adopt_orchestrator_ssh_agent

  set_status preparing "Fetching release v${TARGET_VERSION}..."
  git -C "$ROOT_DIR" fetch --quiet "$REMOTE" "refs/tags/v${TARGET_VERSION}:refs/tags/v${TARGET_VERSION}" \
    || fail "Release tag v${TARGET_VERSION} was not found on ${REMOTE}."
  set_status preparing "Pulling the v${TARGET_VERSION} images; the current version keeps running..."
  prefetch_images "$data_dir" \
    || fail "The v${TARGET_VERSION} images are not available (not published yet, or no registry access). Nothing was changed."

  host=$(dotenv_value "$ENV_FILE" ADMIN_API_HOST)
  port=$(dotenv_value "$ENV_FILE" ADMIN_API_PORT)
  url=$(health_url "$host" "$port")
  drain=$(dotenv_value "$ENV_FILE" SHUTDOWN_DRAIN_TIMEOUT_MS)
  stop_timeout=$(orchestrator_stop_timeout "$drain") || fail "Invalid SHUTDOWN_DRAIN_TIMEOUT_MS."

  snapshot "$data_dir" || fail "Could not snapshot the current installation. Nothing was changed."
  info "Snapshot saved in ${BACKUP_DIR}."

  if [[ "$(docker inspect --format '{{.State.Running}}' ve-orchestrator 2>/dev/null || true)" == "true" ]]; then
    set_status draining "Waiting for running agent cycles to finish (up to ${stop_timeout}s); no new work starts."
    docker stop --time "$stop_timeout" ve-orchestrator >/dev/null \
      || rollback "$data_dir" "Could not stop the orchestrator." "$url"
  fi
  backup_database "$data_dir" || rollback "$data_dir" "Could not back up the database." "$url"

  set_status starting "Starting v${TARGET_VERSION}..."
  git -C "$ROOT_DIR" checkout --quiet --detach "v${TARGET_VERSION}" \
    || rollback "$data_dir" "Could not check out v${TARGET_VERSION}." "$url"
  set_env_value "$ENV_FILE" VE_IMAGE_TAG "$TARGET_VERSION" \
    || rollback "$data_dir" "Could not record VE_IMAGE_TAG in .env." "$url"
  (cd "$ROOT_DIR" && VE_IMAGE_TAG="$TARGET_VERSION" ./scripts/start.sh) \
    || rollback "$data_dir" "start.sh failed for v${TARGET_VERSION}." "$url"

  set_status verifying "Waiting for v${TARGET_VERSION} to report healthy..."
  wait_for_health "$url" \
    || rollback "$data_dir" "v${TARGET_VERSION} did not become healthy within ${HEALTH_TIMEOUT}s." "$url"
  running_label=$(docker inspect ve-orchestrator \
    --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)
  [[ "$running_label" == "$TARGET_VERSION" ]] \
    || rollback "$data_dir" "The running image reports version '${running_label}', not ${TARGET_VERSION}." "$url"

  prune_update_backups "$data_dir/backups" "$KEEP_BACKUPS" || warn "Could not prune old update backups."
  set_status succeeded "Updated from ${CURRENT_VERSION} to ${TARGET_VERSION}."
}

main() {
  local mode="update" requested="" data_dir
  case "${1:-}" in
    --help|-h) sed -n '2,26p' "$0"; return 0 ;;
    --check|--install-service|--uninstall-service|--from-request) mode="${1#--}"; shift ;;
    -*) echo "Unknown option: $1. Run ./scripts/update.sh --help" >&2; return 1 ;;
    "") ;;
    *) requested="$1"; shift ;;
  esac
  [[ $# -eq 0 ]] || { echo "Unexpected arguments: $*" >&2; return 1; }
  [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "VE_UPDATE_HEALTH_TIMEOUT must be a positive integer." >&2; return 1; }
  [[ "$KEEP_BACKUPS" =~ ^[1-9][0-9]*$ ]] || { echo "VE_UPDATE_KEEP_BACKUPS must be a positive integer." >&2; return 1; }

  data_dir=$(resolve_data_dir)
  case "$mode" in
    install-service) install_service "$data_dir"; return 0 ;;
    uninstall-service) uninstall_service "$data_dir"; return 0 ;;
    check)
      echo "Running version: $(running_version)"
      echo "Latest release:  $(latest_release || echo unavailable)"
      return 0 ;;
  esac

  # Consume the request before anything that can fail so systemd does not
  # retrigger the service in a loop.
  if [[ "$mode" == "from-request" ]]; then
    requested=$(read_update_request "$data_dir/$UPDATE_REQUEST_FILE" 2>/dev/null || true)
    rm -f "$data_dir/$UPDATE_REQUEST_FILE"
  fi

  exec 9>"$data_dir/.update.lock"
  flock -n 9 || { echo "[ERROR] Another update is already running." >&2; return 1; }
  exec > >(tee "$data_dir/update.log") 2>&1

  STATUS_PATH="$data_dir/$UPDATE_STATUS_FILE"
  CURRENT_VERSION=$(running_version)
  if [[ "$mode" == "from-request" && -z "$requested" ]]; then
    fail "The update request from the admin UI was missing or invalid."
  fi
  if [[ -n "$requested" ]]; then
    TARGET_VERSION=$(normalize_release_version "$requested") || fail "Invalid release version: ${requested}"
  else
    TARGET_VERSION=$(latest_release) || fail "Could not determine the latest release from ${RELEASES_API}."
  fi

  if [[ "$TARGET_VERSION" == "$CURRENT_VERSION" ]]; then
    set_status succeeded "Already running ${CURRENT_VERSION}."
    return 0
  fi
  if [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && version_lt "$TARGET_VERSION" "$CURRENT_VERSION"; then
    fail "Refusing to downgrade from ${CURRENT_VERSION} to ${TARGET_VERSION}: the database may already use newer migrations. Restore a backup from ${data_dir}/backups instead."
  fi
  run_update "$data_dir"
}

main "$@"; exit $?
