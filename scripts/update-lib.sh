#!/usr/bin/env bash
# Helpers for scripts/update.sh. Requires scripts/start-lib.sh.
#
# Files shared with the orchestrator (src/runtime/updateHandshake.ts), all in
# DATA_DIR next to the database:
#   update.request     written by the admin UI; consumed by the updater service
#   update.status      written here; read by the admin UI
#   updater.installed  written by --install-service; enables the UI button

UPDATE_REQUEST_FILE="update.request"
UPDATE_STATUS_FILE="update.status"
UPDATER_INSTALLED_FILE="updater.installed"

# Prints one variable from a dotenv file without exporting the rest. Variables
# already set in the environment win, as in start.sh.
dotenv_value() {
  local env_file="$1" key="$2"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  (
    load_dotenv "$env_file"
    printf '%s' "${!key:-}"
  )
}

# Replaces (or appends) KEY=value in a dotenv file, keeping every other line
# and the file mode. Values are written unquoted, so callers must validate them.
set_env_value() {
  local env_file="$1" key="$2" value="$3" temporary
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  [[ "$value" =~ ^[A-Za-z0-9._:/@-]*$ ]] || return 1
  temporary=$(mktemp "${env_file}.XXXXXX") || return 1
  if [[ -f "$env_file" ]]; then
    chmod --reference="$env_file" "$temporary" 2>/dev/null || true
    awk -v key="$key" -v value="$value" '
      BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" }
      $0 ~ pattern { if (!done) print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$env_file" > "$temporary" || { rm -f "$temporary"; return 1; }
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi
  mv "$temporary" "$env_file"
}

# Prints the validated version from an update request file.
read_update_request() {
  local file="$1" version
  [[ -f "$file" ]] || return 1
  version=$(sed -n 's/^version=//p' "$file" | head -n1 | tr -d '\r')
  normalize_release_version "$version"
}

# Atomically writes the status file the admin UI shows.
#   write_update_status FILE STATE FROM TO MESSAGE
write_update_status() {
  local file="$1" state="$2" from="$3" to="$4" message="$5" temporary
  message=$(printf '%s' "$message" | tr '\r\n\t' '   ' | cut -c1-500)
  temporary=$(mktemp "${file}.XXXXXX") || return 1
  {
    printf 'state=%s\n' "$state"
    printf 'from=%s\n' "$from"
    printf 'to=%s\n' "$to"
    printf 'message=%s\n' "$message"
    printf 'updated_at=%s\n' "$(date +%s)"
  } > "$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$file"
}

# Prints the tag_name of a GitHub "latest release" API response read on stdin.
parse_release_tag() {
  grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Succeeds when release version $1 is strictly older than $2 (both X.Y.Z).
version_lt() {
  local -a left right
  local index
  IFS=. read -r -a left <<< "$1"
  IFS=. read -r -a right <<< "$2"
  for index in 0 1 2; do
    (( 10#${left[index]} < 10#${right[index]} )) && return 0
    (( 10#${left[index]} > 10#${right[index]} )) && return 1
  done
  return 1
}

# Prints the local URL of the orchestrator health endpoint.
health_url() {
  local host="${1:-127.0.0.1}" port="${2:-3100}"
  case "$host" in
    ""|0.0.0.0|localhost) host="127.0.0.1" ;;
    ::|"[::]") host="[::1]" ;;
    *:*) [[ "$host" == \[* ]] || host="[${host}]" ;;
  esac
  printf 'http://%s:%s/health\n' "$host" "$port"
}

# The rollback tag kept for a local image name (name:tag -> name:ve-rollback).
rollback_image_tag() {
  local image="$1" name="$1"
  local last="${image##*/}"
  [[ "$last" == *:* ]] && name="${image%:*}"
  printf '%s:ve-rollback\n' "$name"
}

# Deletes all but the newest KEEP update backups in DIR.
prune_update_backups() {
  local dir="$1" keep="$2" backup
  [[ -d "$dir" ]] || return 0
  [[ "$keep" =~ ^[0-9]+$ ]] || return 1
  while IFS= read -r backup; do
    [[ -n "$backup" ]] && rm -rf -- "${dir:?}/${backup}"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -name 'update-*' -printf '%f\n' \
    | sort -r | tail -n +$((keep + 1)))
}

# Prints the systemd path + service units that run update.sh for UI requests.
#   updater_units ROOT_DIR DATA_DIR USER GROUP HOME PATH
updater_units() {
  local root="$1" data="$2" user="$3" group="$4" home="$5" path="$6" value
  for value in "$root" "$data" "$home" "$path"; do
    if [[ "$value" =~ [[:space:]%\"\'\\] ]]; then
      printf 'Paths used by the updater service must not contain whitespace, quotes, backslashes or %%: %s\n' "$value" >&2
      return 1
    fi
  done
  cat <<EOF
# --- virtual-engineer-updater.path
[Unit]
Description=Watch for Virtual Engineer update requests from the admin UI

[Path]
PathExists=${data}/${UPDATE_REQUEST_FILE}
Unit=virtual-engineer-updater.service

[Install]
WantedBy=multi-user.target
# --- virtual-engineer-updater.service
[Unit]
Description=Update Virtual Engineer to the release requested in the admin UI
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${user}
Group=${group}
WorkingDirectory=${root}
Environment=HOME=${home}
Environment=PATH=${path}
Environment=DATA_DIR=${data}
ExecStart=${root}/scripts/update.sh --from-request
TimeoutStartSec=4h
EOF
}
