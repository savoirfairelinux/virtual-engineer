#!/usr/bin/env bash
# start.sh — One-shot setup + launch for Virtual Engineer.
#   Builds the agent + orchestrator images, starts an OpenShell gateway using
#   its Docker compute driver by default, and runs the orchestrator. The
#   experimental Kubernetes driver remains available as an explicit opt-in.
#
# Usage:
#   ./scripts/start.sh                     # full setup + launch
#   ./scripts/start.sh --setup-only        # provision .env and secrets only
#   ./scripts/start.sh --no-k3s-install    # skip k3s auto-install (must already exist)
#   ./scripts/start.sh --restore <archive> [--force] [--yes]  # stop and restore
#
# Optional environment variables:
#   DATA_DIR       (default: ./data)
#   BACKUP_KEYRING_FILE  optional existing keyring override; otherwise generated
#                        under XDG_CONFIG_HOME or ~/.config on normal startup
#   OPENSHELL_STATE_DIR (default: $XDG_STATE_HOME/virtual-engineer or
#                        $HOME/.local/state/virtual-engineer) persistent local
#                        OpenShell/Keycloak bootstrap state
#   OPENSHELL_COMPUTE_DRIVER (default: docker; kubernetes is experimental)
#   K3S_KUBECONFIG (default: /etc/rancher/k3s/k3s.yaml)  k3s admin kubeconfig path
#   OPENSHELL_OIDC_ISSUER external Keycloak realm issuer URL; omit with the
#     client secret to use the managed local Keycloak
#   OPENSHELL_OIDC_CLIENT_SECRET external confidential-client secret
#   OPENSHELL_OIDC_CLIENT_ID (default: openshell-ci)
#   OPENSHELL_OIDC_AUDIENCE (default: openshell-cli)
#   K3S_VERSION (default: v1.32.3+k3s1) fresh-install pin and minimum supported version
#   AGENT_SANDBOX_VERSION (default: v0.5.1) pinned controller manifest version
#   AGENT_SANDBOX_MANIFEST_SHA256 verified manifest digest for that version

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

load_dotenv() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      continue
    fi

    key="${BASH_REMATCH[2]}"
    [[ -n "${!key+x}" ]] && continue
    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 ]]; then
      if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]] \
        || [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$env_file"
}

ensure_env_file() {
  local env_file="$1"
  local env_example="$2"
  local temp_env_file

  if [[ -L "$env_file" || ( -e "$env_file" && ! -f "$env_file" ) ]]; then
    printf 'Refusing to use a non-regular .env file: %s\n' "$env_file" >&2
    return 1
  fi
  [[ -f "$env_example" && ! -L "$env_example" ]] || {
    printf 'Missing regular .env.example file: %s\n' "$env_example" >&2
    return 1
  }
  if [[ ! -e "$env_file" ]]; then
    temp_env_file="$(mktemp "${env_file}.setup.XXXXXX")" || return 1
    chmod 0600 "$temp_env_file" || {
      rm -f -- "$temp_env_file"
      return 1
    }
    if ! cp -- "$env_example" "$temp_env_file"; then
      rm -f -- "$temp_env_file"
      return 1
    fi
    if ! ln -- "$temp_env_file" "$env_file"; then
      rm -f -- "$temp_env_file"
      [[ -f "$env_file" && ! -L "$env_file" ]] || return 1
    else
      rm -f -- "$temp_env_file"
    fi
  fi

  temp_env_file="$(mktemp "${env_file}.merge.XXXXXX")" || return 1
  chmod 0600 "$temp_env_file" || {
    rm -f -- "$temp_env_file"
    return 1
  }
  awk '
    function variable_name(line, assignment) {
      if (!match(line, /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/)) return ""
      assignment = substr(line, RSTART, RLENGTH)
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", assignment)
      sub(/[[:space:]]*=$/, "", assignment)
      return assignment
    }
    FILENAME == ARGV[1] {
      env_lines[++env_line_count] = $0
      variable = variable_name($0)
      if (variable != "") existing[variable] = 1
      next
    }
    {
      variable = variable_name($0)
      if (variable != "" && !(variable in existing) && !(variable in added)) {
        defaults[++default_line_count] = $0
        added[variable] = 1
      }
    }
    END {
      for (line_number = 1; line_number <= env_line_count; line_number++) print env_lines[line_number]
      if (env_line_count > 0 && default_line_count > 0) print ""
      for (line_number = 1; line_number <= default_line_count; line_number++) print defaults[line_number]
    }
  ' "$env_file" "$env_example" > "$temp_env_file" || {
    rm -f -- "$temp_env_file"
    return 1
  }
  if ! cmp -s -- "$env_file" "$temp_env_file"; then
    if ! mv -- "$temp_env_file" "$env_file"; then
      rm -f -- "$temp_env_file"
      return 1
    fi
  else
    rm -f -- "$temp_env_file"
  fi
  chmod 0600 "$env_file"
}

admin_auth_secret_from_env_file() {
  local env_file="$1"
  local line value
  [[ -f "$env_file" && ! -L "$env_file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?ADMIN_AUTH_SECRET[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ ${#value} -ge 2 ]] \
        && { [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]] \
          || [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; }; then
        value="${value:1:${#value}-2}"
      fi
      if [[ -n "$value" && "$value" != \#* ]]; then
        printf '%s' "$value"
        return 0
      fi
    fi
  done < "$env_file"
  return 1
}

backup_keyring_path_from_env_file() {
  local env_file="$1"
  local line value
  [[ -f "$env_file" && ! -L "$env_file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?BACKUP_KEYRING_FILE[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ ${#value} -ge 2 ]] \
        && { [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]] \
          || [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; }; then
        value="${value:1:${#value}-2}"
      fi
      if [[ -n "$value" && "$value" != \#* ]]; then
        printf '%s' "$value"
        return 0
      fi
    fi
  done < "$env_file"
  return 1
}

persist_backup_keyring_file() {
  local env_file="$1"
  local keyring_file="$2"
  local temp_env_file temp_path_file
  local existing_path
  if existing_path="$(backup_keyring_path_from_env_file "$env_file")"; then
    return 0
  fi

  temp_env_file="$(mktemp "${env_file}.keyring.XXXXXX")" || return 1
  temp_path_file="$(mktemp "${env_file}.path.XXXXXX")" || {
    rm -f -- "$temp_env_file"
    return 1
  }
  chmod 0600 "$temp_env_file" "$temp_path_file" || {
    rm -f -- "$temp_env_file" "$temp_path_file"
    return 1
  }
  printf '%s\n' "$keyring_file" > "$temp_path_file" || {
    rm -f -- "$temp_env_file" "$temp_path_file"
    return 1
  }
  awk -v path_file="$temp_path_file" '
    BEGIN {
      if ((getline keyring_path < path_file) <= 0) exit 1
      close(path_file)
    }
    /^[[:space:]]*(export[[:space:]]+)?BACKUP_KEYRING_FILE[[:space:]]*=/ {
      if (!replaced) {
        print "BACKUP_KEYRING_FILE=" keyring_path
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) print "BACKUP_KEYRING_FILE=" keyring_path
    }
  ' "$env_file" > "$temp_env_file" || {
    rm -f -- "$temp_env_file" "$temp_path_file"
    return 1
  }
  rm -f -- "$temp_path_file"
  if ! mv -- "$temp_env_file" "$env_file"; then
    rm -f -- "$temp_env_file"
    return 1
  fi
  chmod 0600 "$env_file"
}

ensure_admin_auth_secret() {
  local env_file="$1"
  local secret="${ADMIN_AUTH_SECRET:-}"
  local temp_env_file temp_secret_file
  ADMIN_AUTH_SECRET_CREATED=false

  if [[ -L "$env_file" || ( -e "$env_file" && ! -f "$env_file" ) ]]; then
    printf 'Refusing to update a non-regular .env file.\n' >&2
    return 1
  fi
  if [[ ! -e "$env_file" ]]; then
    (umask 077; : > "$env_file") || {
      printf 'Could not create .env for ADMIN_AUTH_SECRET.\n' >&2
      return 1
    }
  fi

  if [[ -z "$secret" ]]; then
    if secret="$(admin_auth_secret_from_env_file "$env_file")"; then
      printf -v ADMIN_AUTH_SECRET '%s' "$secret"
      export ADMIN_AUTH_SECRET
      unset secret
      chmod 0600 "$env_file" || return 1
      return 0
    fi
    secret="$(openssl rand -hex 32 | tr -d '\r\n')" || {
      printf 'Could not generate ADMIN_AUTH_SECRET with OpenSSL.\n' >&2
      return 1
    }
    if [[ ! "$secret" =~ ^[a-f0-9]{64}$ ]]; then
      unset secret
      printf 'OpenSSL returned an invalid ADMIN_AUTH_SECRET.\n' >&2
      return 1
    fi
    temp_env_file="$(mktemp "${env_file}.startup.XXXXXX")" || return 1
    temp_secret_file="$(mktemp "${env_file}.secret.XXXXXX")" || {
      rm -f -- "$temp_env_file"
      return 1
    }
    chmod 0600 "$temp_env_file" "$temp_secret_file" || {
      rm -f -- "$temp_env_file" "$temp_secret_file"
      unset secret
      return 1
    }
    printf '%s\n' "$secret" > "$temp_secret_file" || {
      rm -f -- "$temp_env_file" "$temp_secret_file"
      unset secret
      return 1
    }
    awk -v secret_file="$temp_secret_file" '
      BEGIN {
        if ((getline secret < secret_file) <= 0) exit 1
        close(secret_file)
      }
      /^[[:space:]]*(export[[:space:]]+)?ADMIN_AUTH_SECRET[[:space:]]*=/ {
        if (!replaced) {
          print "ADMIN_AUTH_SECRET=" secret
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) print "ADMIN_AUTH_SECRET=" secret
      }
    ' "$env_file" > "$temp_env_file" || {
      rm -f -- "$temp_env_file" "$temp_secret_file"
      unset secret
      printf 'Could not update .env with ADMIN_AUTH_SECRET.\n' >&2
      return 1
    }
    rm -f -- "$temp_secret_file"
    if ! mv -- "$temp_env_file" "$env_file"; then
      rm -f -- "$temp_env_file"
      unset secret
      printf 'Could not install the generated .env file.\n' >&2
      return 1
    fi
    printf -v ADMIN_AUTH_SECRET '%s' "$secret"
    export ADMIN_AUTH_SECRET
    ADMIN_AUTH_SECRET_CREATED=true
    unset secret
  fi

  chmod 0600 "$env_file"
}

resolve_restore_archive() {
  local archive="${1:-}"
  local resolved
  if [[ -z "$archive" || ! -f "$archive" || -L "$archive" ]]; then
    printf 'Restore source must be an existing regular, non-symlink file.\n' >&2
    return 1
  fi
  resolved=$(realpath -e -- "$archive") || {
    printf 'Could not resolve restore archive path.\n' >&2
    return 1
  }
  if [[ "$resolved" == *","* ]]; then
    printf 'Restore archive paths must not contain commas.\n' >&2
    return 1
  fi
  printf '%s\n' "$resolved"
}

resolve_backup_keyring_file() {
  local keyring="${1:-}"
  local data_dir="${2:-}"
  local backup_dir="${3:-}"
  local resolved_keyring resolved_data_dir resolved_backup_dir
  if [[ -z "$keyring" || ! -f "$keyring" || -L "$keyring" ]]; then
    printf 'Backup keyring must be an existing regular, non-symlink file.\n' >&2
    return 1
  fi
  resolved_keyring=$(realpath -e -- "$keyring") || return 1
  resolved_data_dir=$(realpath -e -- "$data_dir") || return 1
  if [[ "$resolved_keyring" == "$resolved_data_dir" || "$resolved_keyring" == "$resolved_data_dir"/* ]]; then
    printf 'Backup keyring must be stored outside DATA_DIR.\n' >&2
    return 1
  fi
  if [[ -n "$backup_dir" ]]; then
    resolved_backup_dir=$(realpath -m -- "$backup_dir") || return 1
    if [[ "$resolved_keyring" == "$resolved_backup_dir" || "$resolved_keyring" == "$resolved_backup_dir"/* ]]; then
      printf 'Backup keyring must be stored outside BACKUP_DIR.\n' >&2
      return 1
    fi
  fi
  if [[ "$resolved_keyring" == *","* ]]; then
    printf 'Backup keyring paths must not contain commas.\n' >&2
    return 1
  fi
  printf '%s\n' "$resolved_keyring"
}

default_backup_keyring_file_path() {
  local xdg_config_home="${1:-}"
  local home_dir="${2:-}"
  if [[ -n "$xdg_config_home" ]]; then
    printf '%s/virtual-engineer/backup-keyring.json\n' "${xdg_config_home%/}"
  elif [[ -n "$home_dir" ]]; then
    printf '%s/.config/virtual-engineer/backup-keyring.json\n' "${home_dir%/}"
  else
    printf 'Set HOME or XDG_CONFIG_HOME to a persistent directory for the default backup keyring.\n' >&2
    return 1
  fi
}

ensure_private_marker() {
  local marker_file="$1"
  local marker_dir="$(dirname -- "$marker_file")"
  [[ ! -L "$marker_file" && ( ! -e "$marker_file" || -f "$marker_file" ) ]] || {
    printf 'Setup marker must be a regular, non-symlink file: %s\n' "$marker_file" >&2
    return 1
  }
  mkdir -p -- "$marker_dir" || return 1
  if [[ ! -e "$marker_file" ]]; then
    if ! (umask 077; set -o noclobber; : > "$marker_file") \
      && [[ -L "$marker_file" || ! -f "$marker_file" ]]; then
      printf 'Could not create setup marker: %s\n' "$marker_file" >&2
      return 1
    fi
  fi
  chmod 0600 -- "$marker_file"
}

create_backup_keyring_file_at_path() {
  local keyring_file="$1"
  local data_dir="$2"
  local backup_dir="$3"
  local onboarding_marker="$4"
  local resolved_keyring resolved_data_dir resolved_backup_dir keyring_dir
  local key key_id

  [[ ! -L "$keyring_file" ]] || {
    printf 'Backup keyring must not be a symlink.\n' >&2
    return 1
  }
  resolved_keyring=$(realpath -m -- "$keyring_file") || return 1
  resolved_data_dir=$(realpath -e -- "$data_dir") || return 1
  resolved_backup_dir=$(realpath -m -- "$backup_dir") || return 1
  if [[ "$resolved_keyring" == "$resolved_data_dir" || "$resolved_keyring" == "$resolved_data_dir"/* \
    || "$resolved_keyring" == "$resolved_backup_dir" || "$resolved_keyring" == "$resolved_backup_dir"/* ]]; then
    printf 'Backup keyring must be stored outside DATA_DIR and BACKUP_DIR.\n' >&2
    return 1
  fi
  if [[ "$resolved_keyring" == *","* ]]; then
    printf 'Backup keyring paths must not contain commas.\n' >&2
    return 1
  fi
  keyring_dir="$(dirname -- "$resolved_keyring")"
  (umask 077; mkdir -p -- "$keyring_dir") || {
    printf 'Could not create the backup keyring directory.\n' >&2
    return 1
  }

  BACKUP_KEYRING_CREATED=false
  if [[ -e "$resolved_keyring" ]]; then
    [[ -f "$resolved_keyring" ]] || {
      printf 'Backup keyring must be a regular file.\n' >&2
      return 1
    }
    chmod 0600 -- "$resolved_keyring" || return 1
    BACKUP_KEYRING_FILE="$resolved_keyring"
    return 0
  fi

  ensure_private_marker "$onboarding_marker" || return 1
  if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js is required to generate the default backup keyring.\n' >&2
    return 1
  fi
  key=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));') || {
    printf 'Could not generate a random backup key.\n' >&2
    return 1
  }
  if [[ ! "$key" =~ ^[a-fA-F0-9]{64}$ ]]; then
    unset key
    printf 'Node.js returned an invalid backup key.\n' >&2
    return 1
  fi
  key_id="key-$(date -u +%Y%m%d)-${key:0:8}"
  if ! (
    umask 077
    set -o noclobber
    printf '{"format":"virtual-engineer-backup-keyring","version":1,"activeKeyId":"%s","keys":{"%s":"%s"}}\n' \
      "$key_id" "$key_id" "$key" > "$resolved_keyring"
  ); then
    unset key
    if [[ -L "$resolved_keyring" || ! -f "$resolved_keyring" ]]; then
      printf 'Could not create the backup keyring without overwriting an existing path.\n' >&2
      return 1
    fi
    chmod 0600 -- "$resolved_keyring" || return 1
    BACKUP_KEYRING_FILE="$resolved_keyring"
    return 0
  fi
  unset key
  chmod 0600 -- "$resolved_keyring" || {
    printf 'Could not secure the generated backup keyring.\n' >&2
    return 1
  }
  BACKUP_KEYRING_FILE="$resolved_keyring"
  BACKUP_KEYRING_CREATED=true
}

ensure_default_backup_keyring_file() {
  local xdg_config_home="${1:-}"
  local home_dir="${2:-}"
  local data_dir="${3:-}"
  local onboarding_dir="${4:-}"
  local keyring_dir resolved_keyring_dir resolved_data_dir keyring_file onboarding_marker

  if [[ -n "$xdg_config_home" ]]; then
    keyring_dir="${xdg_config_home%/}/virtual-engineer"
  elif [[ -n "$home_dir" ]]; then
    keyring_dir="${home_dir%/}/.config/virtual-engineer"
  else
    printf 'Set HOME or XDG_CONFIG_HOME to a persistent directory for the default backup keyring.\n' >&2
    return 1
  fi

  resolved_data_dir=$(realpath -e -- "$data_dir") || {
    printf 'Could not resolve DATA_DIR for the default backup keyring.\n' >&2
    return 1
  }
  resolved_keyring_dir=$(realpath -m -- "$keyring_dir") || {
    printf 'Could not resolve the default backup keyring directory.\n' >&2
    return 1
  }
  if [[ "$resolved_keyring_dir" == "$resolved_data_dir" || "$resolved_keyring_dir" == "$resolved_data_dir"/* ]]; then
    printf 'Default backup keyring must be stored outside DATA_DIR.\n' >&2
    return 1
  fi
  if [[ "$resolved_keyring_dir" == *","* ]]; then
    printf 'Default backup keyring paths must not contain commas.\n' >&2
    return 1
  fi

  mkdir -p -- "$resolved_keyring_dir" || {
    printf 'Could not create the default backup keyring directory.\n' >&2
    return 1
  }
  chmod 0700 -- "$resolved_keyring_dir" || {
    printf 'Could not secure the default backup keyring directory.\n' >&2
    return 1
  }
  resolved_keyring_dir=$(realpath -e -- "$resolved_keyring_dir") || {
    printf 'Could not resolve the created backup keyring directory.\n' >&2
    return 1
  }
  if [[ "$resolved_keyring_dir" == "$resolved_data_dir" || "$resolved_keyring_dir" == "$resolved_data_dir"/* ]]; then
    printf 'Default backup keyring must be stored outside DATA_DIR.\n' >&2
    return 1
  fi

  keyring_file="${resolved_keyring_dir}/backup-keyring.json"
  onboarding_dir="${onboarding_dir:-$resolved_data_dir}"
  mkdir -p -- "$onboarding_dir" || return 1
  resolved_keyring_dir=$(realpath -e -- "$resolved_keyring_dir") || return 1
  keyring_file="${resolved_keyring_dir}/backup-keyring.json"
  onboarding_marker="$(realpath -e -- "$onboarding_dir")/.backup-keyring-onboarding-pending"
  create_backup_keyring_file_at_path "$keyring_file" "$resolved_data_dir" \
    "${BACKUP_DIR:-$(dirname -- "$resolved_data_dir")/backups}" "$onboarding_marker"
}

ensure_instance_secrets() {
  local env_file="$1"
  local data_dir="$2"
  local database_path="${3:-./data/virtual-engineer.db}"
  local backup_dir="${4:-}"
  local xdg_config_home="${5:-}"
  local home_dir="${6:-${HOME:-}}"
  local resolved_data_dir resolved_database_path state_dir resolved_backup_dir
  local provisioned_marker onboarding_marker admin_onboarding_marker expected_keyring
  local admin_present=false keyring_present=false initialized=false archive

  [[ -f "$env_file" && ! -L "$env_file" ]] || {
    printf 'Setup requires a regular, non-symlink .env file.\n' >&2
    return 1
  }
  resolved_data_dir=$(realpath -e -- "$data_dir") || {
    printf 'Could not resolve DATA_DIR for secret setup.\n' >&2
    return 1
  }
  resolved_database_path=$(realpath -m -- "$database_path") || return 1
  state_dir="$(dirname -- "$resolved_database_path")"
  if [[ -z "$backup_dir" ]]; then
    resolved_backup_dir="${state_dir}/backups"
  else
    resolved_backup_dir=$(realpath -m -- "$backup_dir") || return 1
  fi
  mkdir -p -- "$state_dir" || return 1
  provisioned_marker="${state_dir}/.secrets-provisioned"
  onboarding_marker="${state_dir}/.backup-keyring-onboarding-pending"
  admin_onboarding_marker="${state_dir}/.admin-auth-secret-onboarding-pending"

  if [[ -n "${ADMIN_AUTH_SECRET:-}" ]] || admin_auth_secret_from_env_file "$env_file" >/dev/null 2>&1; then
    admin_present=true
  fi
  if [[ -n "${BACKUP_KEYRING_FILE:-}" ]]; then
    if [[ -L "$BACKUP_KEYRING_FILE" ]]; then
      printf 'Configured BACKUP_KEYRING_FILE must not be a symlink.\n' >&2
      return 1
    fi
    if [[ -e "$BACKUP_KEYRING_FILE" ]]; then
      resolve_backup_keyring_file "$BACKUP_KEYRING_FILE" "$resolved_data_dir" "$resolved_backup_dir" >/dev/null || return 1
      keyring_present=true
    fi
  else
    expected_keyring=$(default_backup_keyring_file_path "$xdg_config_home" "$home_dir") || return 1
    if [[ -L "$expected_keyring" ]]; then
      printf 'Default backup keyring must not be a symlink.\n' >&2
      return 1
    fi
    if [[ -e "$expected_keyring" ]]; then
      [[ -f "$expected_keyring" ]] || {
        printf 'Default backup keyring must be a regular file.\n' >&2
        return 1
      }
      resolve_backup_keyring_file "$expected_keyring" "$resolved_data_dir" "$resolved_backup_dir" >/dev/null || return 1
      keyring_present=true
    fi
  fi

  if [[ -e "$provisioned_marker" || -L "$provisioned_marker" \
    || -e "$resolved_database_path" || -e "${resolved_database_path}-wal" \
    || -e "${resolved_database_path}-shm" ]]; then
    initialized=true
  fi
  for archive in "$resolved_backup_dir"/ve-backup-*.tar.gz.enc "$resolved_backup_dir"/ve-backup-*.tar.gz; do
    if [[ -f "$archive" || -L "$archive" ]]; then
      initialized=true
      break
    fi
  done
  if [[ "$initialized" == "true" && ( "$admin_present" != "true" || "$keyring_present" != "true" ) ]]; then
    printf 'Refusing to generate missing secrets for an initialized instance. Restore its original ADMIN_AUTH_SECRET and BACKUP_KEYRING_FILE; a replacement cannot decrypt existing credentials or backups.\n' >&2
    return 1
  fi

  ensure_admin_auth_secret "$env_file" || return 1
  if [[ "$ADMIN_AUTH_SECRET_CREATED" == "true" ]]; then
    ensure_private_marker "$admin_onboarding_marker" || return 1
  fi
  if [[ -n "${BACKUP_KEYRING_FILE:-}" ]]; then
    if [[ ! -e "$BACKUP_KEYRING_FILE" ]]; then
      [[ "$initialized" != "true" ]] || return 1
      create_backup_keyring_file_at_path "$BACKUP_KEYRING_FILE" "$resolved_data_dir" \
        "$resolved_backup_dir" "$onboarding_marker" || return 1
    else
      chmod 0600 -- "$BACKUP_KEYRING_FILE" || return 1
      BACKUP_KEYRING_CREATED=false
    fi
  else
    ensure_default_backup_keyring_file "$xdg_config_home" "$home_dir" \
      "$resolved_data_dir" "$state_dir" || return 1
  fi
  if [[ "$keyring_present" == "true" \
    && ( "$initialized" != "true" || -f "$admin_onboarding_marker" ) ]]; then
    ensure_private_marker "$onboarding_marker" || return 1
  fi
  resolve_backup_keyring_file "$BACKUP_KEYRING_FILE" "$resolved_data_dir" "$resolved_backup_dir" >/dev/null || return 1
  persist_backup_keyring_file "$env_file" "$BACKUP_KEYRING_FILE" || return 1

  ensure_private_marker "$provisioned_marker"
}

backup_keyring_startup_notice() {
  local keyring="${1:-}"
  [[ -n "$keyring" ]] && return 0
  printf '%s\n' \
    "BACKUP_KEYRING_FILE is not configured; new backups and encrypted restores will fail." \
    "Set it in .env to the original keyring's absolute path; encrypted restores require the original key. See README.md, Backups and recovery."
}

confirm_backup_restore() {
  local archive="$1"
  local data_dir="$2"
  local assume_yes="$3"
  local response
  [[ "$assume_yes" == "true" ]] && return 0
  if [[ ! -t 0 ]]; then
    printf 'Restore requires interactive confirmation; pass --yes to acknowledge it.\n' >&2
    return 1
  fi
  printf 'This will stop the existing Virtual Engineer instance and restore %s into %s.\n' \
    "$archive" "$data_dir" >&2
  printf 'Type restore to continue: ' >&2
  IFS= read -r response || return 1
  if [[ "$response" != "restore" ]]; then
    printf 'Restore cancelled.\n' >&2
    return 1
  fi
}

oidc_mode() {
  local issuer="$1"
  local client_secret="$2"
  if [[ -z "$issuer" && -z "$client_secret" ]]; then
    printf 'local\n'
    return 0
  fi
  if [[ -n "$issuer" && -n "$client_secret" ]]; then
    printf 'external\n'
    return 0
  fi
  printf 'OPENSHELL_OIDC_ISSUER and OPENSHELL_OIDC_CLIENT_SECRET must be set together.\n' >&2
  return 1
}

normalize_review_diff_tmpfs_size() {
  local value="${1:-2g}"
  if [[ ! "$value" =~ ^[1-9][0-9]*[mg]$ ]]; then
    printf 'REVIEW_DIFF_TMPFS_SIZE must be a positive integer followed by m or g (for example 512m or 2g).\n' >&2
    return 1
  fi
  printf '%s\n' "$value"
}

normalize_openshell_compute_driver() {
  local value="${1:-}"
  case "$value" in
    ""|docker)
      printf 'docker\n'
      ;;
    kubernetes)
      printf 'kubernetes\n'
      ;;
    *)
      printf 'OPENSHELL_COMPUTE_DRIVER must be docker or kubernetes, got: %s\n' "$value" >&2
      return 1
      ;;
  esac
}

resolve_openshell_state_dir() {
  local configured_dir="$1"
  local xdg_state_home="$2"
  local home_dir="$3"
  if [[ -n "$configured_dir" ]]; then
    printf '%s\n' "$configured_dir"
  elif [[ -n "$xdg_state_home" ]]; then
    printf '%s/virtual-engineer\n' "$xdg_state_home"
  elif [[ -n "$home_dir" ]]; then
    printf '%s/.local/state/virtual-engineer\n' "$home_dir"
  else
    printf 'Set OPENSHELL_STATE_DIR, XDG_STATE_HOME, or HOME: managed OpenShell state must outlive the checkout.\n' >&2
    return 1
  fi
}

migrate_local_oidc_state() {
  local legacy_dir="$1"
  local state_dir="$2"
  local secret_name target
  [[ "$legacy_dir" != "$state_dir" ]] || return 0
  [[ -d "$legacy_dir" && ! -L "$legacy_dir" ]] || return 0
  if [[ -e "$state_dir" || -L "$state_dir" ]]; then
    [[ -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  fi
  mkdir -p "$state_dir"
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  chmod 700 "$state_dir"
  for secret_name in client-secret admin-password; do
    target="$state_dir/$secret_name"
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" ]] || return 1
      continue
    fi
    [[ -f "$legacy_dir/$secret_name" && ! -L "$legacy_dir/$secret_name" ]] || continue
    install -m 600 "$legacy_dir/$secret_name" "$target"
  done
}

toml_escape_string() {
  local value="$1"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    printf 'OpenShell gateway configuration values must not contain control characters.\n' >&2
    return 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

write_docker_gateway_config() {
  local config_path="$1"
  local oidc_issuer="$2"
  local sandbox_image="$3"
  local supervisor_image="$4"
  local gateway_port="$5"
  local jwt_dir="$6"
  local health_port
  local escaped_issuer escaped_sandbox_image escaped_supervisor_image escaped_jwt_dir

  [[ -n "$config_path" ]] || return 1
  [[ -n "$oidc_issuer" ]] || return 1
  [[ -n "$sandbox_image" ]] || return 1
  [[ -n "$supervisor_image" ]] || return 1
  [[ -n "$jwt_dir" ]] || return 1
  if [[ ! "$gateway_port" =~ ^[0-9]+$ ]] \
    || (( gateway_port < 1 || gateway_port >= 65535 )); then
    printf 'OpenShell gateway port must be an integer between 1 and 65534.\n' >&2
    return 1
  fi
  health_port=$((gateway_port + 1))

  escaped_issuer=$(toml_escape_string "$oidc_issuer") || return 1
  escaped_sandbox_image=$(toml_escape_string "$sandbox_image") || return 1
  escaped_supervisor_image=$(toml_escape_string "$supervisor_image") || return 1
  escaped_jwt_dir=$(toml_escape_string "$jwt_dir") || return 1

  mkdir -p "$(dirname "$config_path")"
  cat > "$config_path" <<EOF
[openshell]
version = 1

[openshell.gateway]
bind_address = "0.0.0.0:${gateway_port}"
health_bind_address = "0.0.0.0:${health_port}"
log_level = "info"
compute_drivers = ["docker"]
disable_tls = true

[openshell.gateway.auth]
allow_unauthenticated_users = false

[openshell.gateway.oidc]
issuer = "${escaped_issuer}"
audience = "openshell-cli"
jwks_ttl_secs = 3600
roles_claim = "realm_access.roles"
admin_role = "openshell-admin"
user_role = "openshell-user"
scopes_claim = ""

[openshell.gateway.gateway_jwt]
signing_key_path = "${escaped_jwt_dir}/signing.pem"
public_key_path = "${escaped_jwt_dir}/public.pem"
kid_path = "${escaped_jwt_dir}/kid"
gateway_id = "virtual-engineer"
ttl_secs = 7200

[openshell.drivers.docker]
default_image = "${escaped_sandbox_image}"
supervisor_image = "${escaped_supervisor_image}"
image_pull_policy = "IfNotPresent"
sandbox_namespace = "virtual-engineer"
grpc_endpoint = "http://host.openshell.internal:${gateway_port}"
network_name = "openshell-docker"
enable_bind_mounts = false
sandbox_pids_limit = 2048
EOF
  chmod 600 "$config_path"
}

load_or_create_secret() {
  local secret_file="$1"
  if [[ ! -s "$secret_file" ]]; then
    mkdir -p "$(dirname "$secret_file")"
    umask 077
    openssl rand -hex 32 | tr -d '\r\n' > "$secret_file"
  else
    local normalized
    normalized=$(tr -d '\r\n' < "$secret_file")
    printf '%s' "$normalized" > "$secret_file"
  fi
  chmod 600 "$secret_file"
  tr -d '\r\n' < "$secret_file"
}

restore_kubernetes_secret_value() {
  local kubeconfig="$1"
  local namespace="$2"
  local secret_name="$3"
  local key="$4"
  local destination="$5"
  [[ -s "$destination" ]] && return 0
  mkdir -p "$(dirname "$destination")"
  umask 077
  KUBECONFIG="$kubeconfig" kubectl get secret "$secret_name" -n "$namespace" \
    -o "jsonpath={.data.${key}}" 2>/dev/null | base64 --decode > "$destination" \
    || rm -f "$destination"
  [[ -s "$destination" ]] || { rm -f "$destination"; return 1; }
  chmod 600 "$destination"
}

can_prepare_k3s() {
  local cluster_ready="$1"
  local no_new_privileges="$2"
  [[ "$cluster_ready" == "true" || "$no_new_privileges" != "true" ]]
}

image_ids_match() {
  local docker_id="$1"
  local runtime_id="$2"
  [[ -n "$docker_id" && -n "$runtime_id" ]] \
    && [[ "$runtime_id" == *"${docker_id#sha256:}"* ]]
}

wait_for_tcp_listener() {
  local pid="$1"
  local host="$2"
  local port="$3"
  local attempts="${4:-30}"
  while (( attempts > 0 )); do
    kill -0 "$pid" 2>/dev/null || return 1
    if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    sleep 1
    ((attempts--)) || true
  done
  return 1
}

wait_for_tcp_port() {
  local host="$1"
  local port="$2"
  local attempts="${3:-30}"
  while (( attempts > 0 )); do
    if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    sleep 1
    ((attempts--)) || true
  done
  return 1
}

wait_for_container_log() {
  local container="$1"
  local pattern="$2"
  local attempts="${3:-30}"
  while (( attempts > 0 )); do
    if docker logs "$container" 2>&1 | grep -F -- "$pattern" >/dev/null; then
      return 0
    fi
    sleep 1
    ((attempts--)) || true
  done
  return 1
}

is_managed_openshell_port_forward() {
  local pid="$1"
  local workspace="$2"
  local process_uid process_name process_cwd
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/${pid}/status" && -r "/proc/${pid}/comm" ]] || return 1
  process_uid=$(awk '$1 == "Uid:" { print $2; exit }' "/proc/${pid}/status")
  process_name=$(cat "/proc/${pid}/comm")
  process_cwd=$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)
  [[ "$process_uid" == "$(id -u)" ]] \
    && [[ "$process_name" == "kubectl" ]] \
    && [[ "$process_cwd" == "$workspace" ]]
}

stop_managed_openshell_port_forward() {
  local pid_file="$1"
  local port="$2"
  local workspace="$3"
  local pid pid_file_value listener_pids
  local -A seen=()

  pid_file_value=$(cat "$pid_file" 2>/dev/null || true)
  listener_pids=""
  if command -v fuser >/dev/null 2>&1; then
    listener_pids=$(fuser -n tcp "$port" 2>/dev/null || true)
  fi

  for pid in $pid_file_value $listener_pids; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    [[ -z "${seen[$pid]:-}" ]] || continue
    seen[$pid]=1
    is_managed_openshell_port_forward "$pid" "$workspace" || continue
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || return 1
    fi
  done
  rm -f "$pid_file"
}

run_config_hash() {
  local env_file="$1"
  shift
  {
    printf 'virtual-engineer-run-config-v1\0'
    if [[ -f "$env_file" ]]; then
      printf 'env-present\0'
      cat "$env_file"
    else
      printf 'env-missing\0'
    fi
    printf '\0docker-args\0'
    printf '%s\0' "$@"
  } | sha256sum | cut -d' ' -f1
}

should_reuse_container() {
  local running="$1"
  local running_image="$2"
  local latest_image="$3"
  local stored_config_hash="$4"
  local current_config_hash="$5"

  [[ "$running" == "true" ]] \
    && [[ -n "$running_image" ]] \
    && [[ -n "$latest_image" ]] \
    && [[ "$running_image" == "$latest_image" ]] \
    && [[ "$stored_config_hash" == "$current_config_hash" ]]
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

set -euo pipefail

cd "$ROOT_DIR"
load_dotenv "$ROOT_DIR/.env"

# Parse arguments before validating deployment settings so --setup-only needs
# only the configuration required to provision the instance.
K3S_INSTALL=true
RESTORE_ARCHIVE=""
RESTORE_CONFIRM_YES=false
RESTORE_FORCE=false
SETUP_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-only)
      SETUP_ONLY=true; shift ;;
    --no-k3s-install)
      K3S_INSTALL=false; shift ;;
    --restore)
      [[ -z "$RESTORE_ARCHIVE" ]] || error "--restore may only be provided once."
      [[ $# -ge 2 ]] || error "--restore requires an archive path."
      RESTORE_ARCHIVE=$(resolve_restore_archive "$2") \
        || error "Restore archive must be an existing regular, non-symlink file."
      shift 2 ;;
    --yes)
      RESTORE_CONFIRM_YES=true; shift ;;
    --force)
      RESTORE_FORCE=true; shift ;;
    --help|-h)
      sed -n '2,17p' "$0"; exit 0 ;;
    *)
      error "Unknown argument: $1. Run ./scripts/start.sh --help" ;;
  esac
done
[[ "$RESTORE_CONFIRM_YES" != "true" || -n "$RESTORE_ARCHIVE" ]] \
  || error "--yes can only be used with --restore."
[[ "$RESTORE_FORCE" != "true" || -n "$RESTORE_ARCHIVE" ]] \
  || error "--force can only be used with --restore."
[[ "$SETUP_ONLY" != "true" || -z "$RESTORE_ARCHIVE" ]] \
  || error "--setup-only cannot be combined with --restore."
ensure_env_file "$ROOT_DIR/.env" "$ROOT_DIR/.env.example" \
  || error "Could not create or protect ${ROOT_DIR}/.env."
load_dotenv "$ROOT_DIR/.env"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
DATABASE_PATH="${DATABASE_PATH:-./data/virtual-engineer.db}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname -- "$DATABASE_PATH")/backups}"

if [[ "$SETUP_ONLY" == "true" ]]; then
  mkdir -p -- "$DATA_DIR" || error "Could not create DATA_DIR: ${DATA_DIR}"
  DATA_DIR="$(cd "$DATA_DIR" && pwd)"
  ensure_instance_secrets "$ROOT_DIR/.env" "$DATA_DIR" "$DATABASE_PATH" "$BACKUP_DIR" \
    "${XDG_CONFIG_HOME:-}" "${HOME:-}" \
    || error "Could not create or load the instance secrets."
  if [[ "$ADMIN_AUTH_SECRET_CREATED" == "true" ]]; then
    info "Generated ADMIN_AUTH_SECRET and protected it in .env."
  fi
  if [[ "$BACKUP_KEYRING_CREATED" == "true" ]]; then
    info "Created backup encryption keyring at ${BACKUP_KEYRING_FILE}."
    info "The generated secrets will be available once to the first admin after startup."
  fi
  info "Setup complete; existing secret values were preserved."
  exit 0
fi

# A /etc/localtime bind mount alone can leave Node using UTC in the container.
ORCHESTRATOR_TIMEZONE=$(node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')
BACKUP_ACCESS_GID="${BACKUP_ACCESS_GID:-${SUDO_GID:-$(id -g)}}"
OPENSHELL_VERSION="v0.0.83"
OPENSHELL_INSTALLER_SHA256="c15d6cb8090e1c7c8d79a320b5bcbdaf1c15c2363942d81e84b56e03b836249e"
OPENSHELL_CHART_DIGEST="sha256:583bcd4eecf7a255c6201ba3b571b5207ee0f643630dfa4835e981e62c754cc7"
OPENSHELL_GATEWAY_IMAGE="ghcr.io/nvidia/openshell/gateway:0.0.83@sha256:80e898dc9ad46e4f40b8b0e8648658d0e51b83f1c2071cf4983ac6d52b9c95d6"
OPENSHELL_SUPERVISOR_IMAGE="ghcr.io/nvidia/openshell/supervisor:0.0.83@sha256:9f5c14d914731f84ce38e61cba4cec425a59f0aad4be0c0906342c68ba65a86f"
KEYCLOAK_IMAGE="quay.io/keycloak/keycloak@sha256:98fab020a3a490aba0978f237e2a06cd0ea42bf149c6cf10f11c0aaf27728ff2"
OPENSHELL_GATEWAY_NAME="${OPENSHELL_GATEWAY_NAME:-virtual-engineer}"
OPENSHELL_COMPUTE_DRIVER=$(normalize_openshell_compute_driver "${OPENSHELL_COMPUTE_DRIVER:-}") \
  || error "Unsupported OpenShell compute driver."
OPENSHELL_OIDC_ISSUER="${OPENSHELL_OIDC_ISSUER:-}"
OPENSHELL_OIDC_CLIENT_ID="${OPENSHELL_OIDC_CLIENT_ID:-openshell-ci}"
OPENSHELL_OIDC_AUDIENCE="${OPENSHELL_OIDC_AUDIENCE:-openshell-cli}"
OPENSHELL_OIDC_CA_CONFIG_MAP="${OPENSHELL_OIDC_CA_CONFIG_MAP:-}"
K3S_VERSION="${K3S_VERSION:-v1.32.3+k3s1}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.5.1}"
AGENT_SANDBOX_MANIFEST_SHA256="${AGENT_SANDBOX_MANIFEST_SHA256:-8cfdf0a878f66b91d2e7103e77859d1412d850ce3f5fe5c3fa134c36bd55504a}"

OIDC_MODE=$(oidc_mode "$OPENSHELL_OIDC_ISSUER" "${OPENSHELL_OIDC_CLIENT_SECRET:-}") \
  || error "Set both OpenShell OIDC values for an external provider, or leave both empty to use local Keycloak."
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  confirm_backup_restore "$RESTORE_ARCHIVE" "$DATA_DIR" "$RESTORE_CONFIRM_YES" \
    || error "Backup restore was not confirmed."
fi
K3S_KUBECONFIG="${K3S_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
OPENSHELL_GW_LOCAL_PORT="${OPENSHELL_GW_LOCAL_PORT:-30808}"
REVIEW_DIFF_TMPFS_SIZE=$(normalize_review_diff_tmpfs_size "${REVIEW_DIFF_TMPFS_SIZE:-}") \
  || error "Invalid review diff tmpfs size."

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

# The gateway-registration `docker run` steps below write into
# OPENSHELL_CONFIG_DIR as root (the image has no USER directive), so a
# subtree they touch first is root-owned and blocks later host-side writes
# to the same path. Reclaim ownership before creating anything under it.
reclaim_root_owned_tree() {
  local dir="$1"
  [[ -e "$dir" ]] || return 0
  if [[ "$(stat -c '%u' "$dir")" != "$(id -u)" ]]; then
    warn "${dir} is owned by root (a prior gateway-registration container created it). Fixing ownership..."
    sudo chown -R "$(id -u):$(id -g)" "$dir"
  fi
}

ensure_dir "$DATA_DIR"    755
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
if [[ -z "$RESTORE_ARCHIVE" ]]; then
  ensure_instance_secrets "$ROOT_DIR/.env" "$DATA_DIR" "$DATABASE_PATH" "$BACKUP_DIR" \
    "${XDG_CONFIG_HOME:-}" "${HOME:-}" \
    || error "Could not create or load the instance secrets."
  if [[ "$ADMIN_AUTH_SECRET_CREATED" == "true" ]]; then
    info "Generated ADMIN_AUTH_SECRET and protected it in .env."
  fi
  if [[ "$BACKUP_KEYRING_CREATED" == "true" ]]; then
    info "Created backup encryption keyring at ${BACKUP_KEYRING_FILE}."
    warn "Keep a protected copy of this file; encrypted backups cannot be restored without it."
  fi
fi
while IFS= read -r backup_notice; do
  warn "$backup_notice"
done < <(backup_keyring_startup_notice "${BACKUP_KEYRING_FILE:-}")

BACKUP_KEYRING_DOCKER_ARGS=()
if [[ -n "${BACKUP_KEYRING_FILE:-}" ]]; then
  BACKUP_KEYRING_FILE=$(resolve_backup_keyring_file "$BACKUP_KEYRING_FILE" "$DATA_DIR" "$BACKUP_DIR") \
    || error "BACKUP_KEYRING_FILE must be a regular file outside DATA_DIR and BACKUP_DIR."
  BACKUP_KEYRING_DOCKER_ARGS=(
    --mount "type=bind,source=${BACKUP_KEYRING_FILE},target=/app/backup-keyring.json,readonly"
    -e "BACKUP_KEYRING_FILE=/app/backup-keyring.json"
  )
fi
OPENSHELL_PORT_FORWARD_PID="${DATA_DIR}/.openshell-port-forward.pid"
OPENSHELL_CONFIG_DIR="${DATA_DIR}/openshell-cli-config"
ensure_dir "$OPENSHELL_CONFIG_DIR" 700

USER_KUBECONFIG="${DATA_DIR}/kubeconfig"
if [[ -r "$USER_KUBECONFIG" ]] \
  && KUBECONFIG="$USER_KUBECONFIG" kubectl get nodes >/dev/null 2>&1; then
  K3S_KUBECONFIG="$USER_KUBECONFIG"
fi

OIDC_DOCKER_HOST_ARGS=()
if [[ "$OIDC_MODE" == "local" ]]; then
  OPENSHELL_STATE_DIR=$(resolve_openshell_state_dir \
    "${OPENSHELL_STATE_DIR:-}" "${XDG_STATE_HOME:-}" "${HOME:-}") \
    || error "Cannot resolve a persistent OpenShell state directory outside ${ROOT_DIR}."
  [[ ! -L "$OPENSHELL_STATE_DIR" ]] \
    || error "OpenShell state directory must not be a symlink: ${OPENSHELL_STATE_DIR}"
  ensure_dir "$OPENSHELL_STATE_DIR" 700
  OPENSHELL_STATE_DIR="$(cd "$OPENSHELL_STATE_DIR" && pwd)"
  LOCAL_OIDC_DIR="${OPENSHELL_STATE_DIR}/local-oidc"
  LEGACY_LOCAL_OIDC_DIR="${DATA_DIR}/local-oidc"
  migrate_local_oidc_state "$LEGACY_LOCAL_OIDC_DIR" "$LOCAL_OIDC_DIR" \
    || error "Could not migrate managed local OIDC state into ${LOCAL_OIDC_DIR}."
  ensure_dir "$LOCAL_OIDC_DIR" 700
  if [[ "$OPENSHELL_COMPUTE_DRIVER" == "kubernetes" ]]; then
    OPENSHELL_OIDC_ISSUER="http://keycloak.virtual-engineer.svc.cluster.local:8080/realms/openshell"
  else
    OPENSHELL_OIDC_ISSUER="http://keycloak.openshell.internal:18081/realms/openshell"
    OIDC_DOCKER_HOST_ARGS=(--add-host "keycloak.openshell.internal:127.0.0.1")
  fi
  info "No external OIDC configuration found; using managed local Keycloak."
fi

if [[ "$OPENSHELL_COMPUTE_DRIVER" == "kubernetes" ]]; then
warn "The OpenShell Kubernetes compute driver is experimental."
# ─── Preflight: k3s setup needs root, so sudo must be able to escalate ────────
# When 'no_new_privileges' is set on the current shell (e.g. some sandboxed
# terminals or hardened environments), it is inherited and sticky, so sudo
# (a setuid binary) can never gain root from here — no sudoers/NOPASSWD tweak
# helps. Detect it up front and fail fast instead of dying mid-install.
K3S_DIRECT_READY=false
if command -v kubectl >/dev/null 2>&1 \
  && KUBECONFIG="$K3S_KUBECONFIG" kubectl get nodes >/dev/null 2>&1; then
  K3S_DIRECT_READY=true
fi
NO_NEW_PRIVILEGES=false
if [[ "$(id -u)" -ne 0 && "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status 2>/dev/null)" == "1" ]]; then
  NO_NEW_PRIVILEGES=true
fi
if ! can_prepare_k3s "$K3S_DIRECT_READY" "$NO_NEW_PRIVILEGES"; then
  warn "Cannot escalate privileges: 'no_new_privileges' is set on this shell."
  warn "sudo cannot gain root here, so k3s (which needs root) cannot be installed."
  warn ""
  warn "Run this script from a shell where privilege escalation works, e.g.:"
  warn "  - a shell without 'no_new_privileges', or"
  warn "  - directly as root (sudo -i, then re-run)."
  error "Aborting: no_new_privileges prevents sudo from escalating."
fi

# ─── Ensure single-node k3s is installed and ready ────────────────────────────
ensure_k3s() {
  if [[ "$K3S_DIRECT_READY" == "true" ]]; then
    local installed_version
    installed_version=$(KUBECONFIG="$K3S_KUBECONFIG" kubectl version -o json \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).serverVersion.gitVersion))")
    local minimum_core="${K3S_VERSION%%+*}"
    local installed_core="${installed_version%%+*}"
    local oldest_version
    oldest_version=$(printf '%s\n%s\n' "$minimum_core" "$installed_core" | sort -V | head -n 1)
    if [[ "$oldest_version" != "$minimum_core" ]]; then
      error "k3s ${installed_version} is older than the minimum supported ${K3S_VERSION}. Upgrade k3s before continuing."
    fi
    info "k3s ${installed_version} already installed and accessible."
    return
  fi
  if command -v k3s >/dev/null 2>&1 && sudo k3s kubectl get nodes >/dev/null 2>&1; then
    local installed_version
    installed_version=$(k3s --version | awk 'NR == 1 { print $3 }')
    local minimum_core="${K3S_VERSION%%+*}"
    local installed_core="${installed_version%%+*}"
    local oldest_version
    oldest_version=$(printf '%s\n%s\n' "$minimum_core" "$installed_core" | sort -V | head -n 1)
    if [[ "$oldest_version" != "$minimum_core" ]]; then
      error "k3s ${installed_version} is older than the minimum supported ${K3S_VERSION}. Upgrade k3s before continuing."
    fi
    if [[ "$installed_version" != "$K3S_VERSION" ]]; then
      info "k3s ${installed_version} is newer than the ${K3S_VERSION} baseline; continuing."
    else
      info "k3s ${installed_version} already installed and running."
    fi
    return
  fi
  if [[ "$K3S_INSTALL" != "true" ]]; then
    error "k3s is not running and --no-k3s-install was set. Install it first: curl -sfL https://get.k3s.io | sh -"
  fi
  info "Installing single-node k3s (requires sudo)..."
  K3S_INSTALLER_SHA256=d264d4d43f7c5a27b44de0075513fb22dfb02d0b7cd33ba7a3838cb822f4729c
  K3S_INSTALLER=$(mktemp)
  curl -sfL -o "$K3S_INSTALLER" https://get.k3s.io
  echo "$K3S_INSTALLER_SHA256  $K3S_INSTALLER" | sha256sum --check --status \
    || error "k3s installer checksum verification failed."
  if [[ "$(id -u)" -eq 0 ]]; then
    INSTALL_K3S_VERSION="$K3S_VERSION" sh "$K3S_INSTALLER" \
      || error "k3s installation failed."
  else
    sudo env INSTALL_K3S_VERSION="$K3S_VERSION" sh "$K3S_INSTALLER" \
      || error "k3s installation failed."
  fi
  rm -f "$K3S_INSTALLER"
  info "Waiting for the k3s node to become Ready..."
  local retries=60
  until sudo k3s kubectl get nodes 2>/dev/null | grep -q ' Ready' || [[ $retries -eq 0 ]]; do
    sleep 2; ((retries--))
  done
  [[ $retries -gt 0 ]] || error "k3s did not become ready in time."
  info "k3s is ready."
}
ensure_k3s

# ─── User-accessible kubeconfig copy ─────────────────────────────────────────
# /etc/rancher/k3s/k3s.yaml is root-owned. Copy it to DATA_DIR so helm and
# kubectl can be called without sudo for non-cluster-admin operations.
if [[ "$K3S_KUBECONFIG" == "$USER_KUBECONFIG" ]]; then
  info "Using existing user kubeconfig at ${USER_KUBECONFIG}."
elif sudo cp "$K3S_KUBECONFIG" "$USER_KUBECONFIG" 2>/dev/null; then
  sudo chown "$(id -u):$(id -g)" "$USER_KUBECONFIG" 2>/dev/null || true
  chmod 600 "$USER_KUBECONFIG"
  K3S_KUBECONFIG="$USER_KUBECONFIG"
else
  warn "Could not copy kubeconfig to ${USER_KUBECONFIG}; Helm will use sudo paths."
fi

# ─── Agent namespace + least-privilege RBAC on k3s ────────────────────────────
info "Applying agent namespace + RBAC to k3s..."
KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f "$ROOT_DIR/deploy/k8s/00-namespace.yaml" >/dev/null 2>&1 \
  || sudo k3s kubectl apply -f "$ROOT_DIR/deploy/k8s/00-namespace.yaml" >/dev/null 2>&1 \
  || error "Could not create the virtual-engineer namespace."
KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f "$ROOT_DIR/deploy/k8s/15-rbac-openshell.yaml" >/dev/null 2>&1 \
  || sudo k3s kubectl apply -f "$ROOT_DIR/deploy/k8s/15-rbac-openshell.yaml" >/dev/null 2>&1 \
  || error "Could not apply deploy/k8s/15-rbac-openshell.yaml."
KUBECONFIG="$K3S_KUBECONFIG" kubectl delete rolebinding ve-openshell-gateway \
  role ve-agent-pod-manager -n ve-agents --ignore-not-found >/dev/null 2>&1 \
  || sudo k3s kubectl delete rolebinding ve-openshell-gateway \
       role ve-agent-pod-manager -n ve-agents --ignore-not-found >/dev/null 2>&1 \
  || error "Could not remove legacy direct Pod/Secret RBAC."
KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f "$ROOT_DIR/deploy/k8s/16-network-policy-openshell.yaml" >/dev/null 2>&1 \
  || sudo k3s kubectl apply -f "$ROOT_DIR/deploy/k8s/16-network-policy-openshell.yaml" >/dev/null 2>&1 \
  || error "Could not apply the OpenShell gateway NetworkPolicy."

if [[ "$OIDC_MODE" == "local" ]]; then
  info "Reconciling managed local Keycloak..."
  restore_kubernetes_secret_value "$K3S_KUBECONFIG" virtual-engineer \
    ve-local-keycloak OPENSHELL_OIDC_CLIENT_SECRET "${LOCAL_OIDC_DIR}/client-secret" || true
  restore_kubernetes_secret_value "$K3S_KUBECONFIG" virtual-engineer \
    ve-local-keycloak KC_BOOTSTRAP_ADMIN_PASSWORD "${LOCAL_OIDC_DIR}/admin-password" || true
  OPENSHELL_OIDC_CLIENT_SECRET=$(load_or_create_secret "${LOCAL_OIDC_DIR}/client-secret")
  export OPENSHELL_OIDC_CLIENT_SECRET
  KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD=$(load_or_create_secret "${LOCAL_OIDC_DIR}/admin-password")
  KUBECONFIG="$K3S_KUBECONFIG" kubectl create secret generic ve-local-keycloak \
    -n virtual-engineer \
    --from-file="OPENSHELL_OIDC_CLIENT_SECRET=${LOCAL_OIDC_DIR}/client-secret" \
    --from-file="KC_BOOTSTRAP_ADMIN_PASSWORD=${LOCAL_OIDC_DIR}/admin-password" \
    --dry-run=client -o yaml \
    | KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f - >/dev/null \
    || error "Could not reconcile the managed local Keycloak secret."
  KUBECONFIG="$K3S_KUBECONFIG" kubectl apply \
    -f "$ROOT_DIR/deploy/k8s/17-keycloak-local.yaml" >/dev/null \
    || error "Could not deploy managed local Keycloak."
  KUBECONFIG="$K3S_KUBECONFIG" kubectl rollout status deployment/ve-local-keycloak \
    -n virtual-engineer --timeout=240s >/dev/null \
    || error "Managed local Keycloak did not become ready."
  KEYCLOAK_CLUSTER_IP=$(KUBECONFIG="$K3S_KUBECONFIG" kubectl get service keycloak \
    -n virtual-engineer -o jsonpath='{.spec.clusterIP}')
  [[ -n "$KEYCLOAK_CLUSTER_IP" && "$KEYCLOAK_CLUSTER_IP" != "None" ]] \
    || error "Managed local Keycloak Service has no ClusterIP."
  # `--import-realm` skips a realm that already exists, so a PVC written
  # under an older secret (e.g. a cluster reused across sessions) keeps
  # rejecting the current one.
  if ! printf 'grant_type=client_credentials&client_id=%s&client_secret=%s' \
    "$OPENSHELL_OIDC_CLIENT_ID" "$OPENSHELL_OIDC_CLIENT_SECRET" \
    | curl -fsS -o /dev/null --data-binary @- \
      "http://${KEYCLOAK_CLUSTER_IP}:8080/realms/openshell/protocol/openid-connect/token"; then
    error "Managed local Keycloak rejects the ${OPENSHELL_OIDC_CLIENT_ID} secret in ${LOCAL_OIDC_DIR}/client-secret; its PVC-persisted realm predates that file. Re-import the realm with: KUBECONFIG=$K3S_KUBECONFIG kubectl delete deployment/ve-local-keycloak pvc/ve-local-keycloak-data -n virtual-engineer"
  fi
  OIDC_DOCKER_HOST_ARGS=(--add-host "keycloak.virtual-engineer.svc.cluster.local:${KEYCLOAK_CLUSTER_IP}")
fi
else
  command -v docker >/dev/null 2>&1 || error "Docker is required for the default OpenShell compute driver."
  docker info >/dev/null 2>&1 || error "The Docker daemon is not accessible."
  if [[ "$OIDC_MODE" == "local" ]]; then
    OPENSHELL_OIDC_CLIENT_SECRET=$(load_or_create_secret "${LOCAL_OIDC_DIR}/client-secret")
    export OPENSHELL_OIDC_CLIENT_SECRET
    KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD=$(load_or_create_secret "${LOCAL_OIDC_DIR}/admin-password")
    docker network inspect ve-openshell-control >/dev/null 2>&1 \
      || docker network create ve-openshell-control >/dev/null
    docker volume inspect ve-local-keycloak-data >/dev/null 2>&1 \
      || docker volume create ve-local-keycloak-data >/dev/null
    docker rm -f ve-local-keycloak >/dev/null 2>&1 || true
    info "Starting managed local Keycloak in Docker..."
    docker run -d \
      --name ve-local-keycloak \
      --restart unless-stopped \
      --network ve-openshell-control \
      --network-alias keycloak.openshell.internal \
      -p 127.0.0.1:18081:18081 \
      -e KC_HTTP_PORT=18081 \
      -e KC_HOSTNAME=http://keycloak.openshell.internal:18081 \
      -e KC_HTTP_ENABLED=true \
      -e KC_BOOTSTRAP_ADMIN_USERNAME=ve-bootstrap \
      -e "KC_BOOTSTRAP_ADMIN_PASSWORD=${KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD}" \
      -e OPENSHELL_OIDC_CLIENT_SECRET \
      -v ve-local-keycloak-data:/opt/keycloak/data \
      -v "$ROOT_DIR/deploy/docker/keycloak-realm.json:/opt/keycloak/data/import/openshell-realm.json:ro,Z" \
      "$KEYCLOAK_IMAGE" start-dev --import-realm >/dev/null
    _keycloak_ready=false
    for _ in {1..80}; do
      if curl -fsS "http://127.0.0.1:18081/realms/openshell/.well-known/openid-configuration" >/dev/null 2>&1; then
        _keycloak_ready=true
        break
      fi
      sleep 2
    done
    [[ "$_keycloak_ready" == "true" ]] \
      || error "Managed local Keycloak did not become ready. Check: docker logs ve-local-keycloak"
    # `start-dev --import-realm` skips a realm that already exists, so a data
    # volume written under an older secret keeps rejecting the current one.
    if ! printf 'grant_type=client_credentials&client_id=%s&client_secret=%s' \
      "$OPENSHELL_OIDC_CLIENT_ID" "$OPENSHELL_OIDC_CLIENT_SECRET" \
      | curl -fsS -o /dev/null --data-binary @- \
        "http://127.0.0.1:18081/realms/openshell/protocol/openid-connect/token"; then
      error "Managed local Keycloak rejects the ${OPENSHELL_OIDC_CLIENT_ID} secret in ${LOCAL_OIDC_DIR}/client-secret; its stored realm predates that file. Re-import the realm with: docker rm -f ve-local-keycloak && docker volume rm ve-local-keycloak-data"
    fi
  else
    docker network inspect ve-openshell-control >/dev/null 2>&1 \
      || docker network create ve-openshell-control >/dev/null
  fi
  docker network inspect openshell-docker >/dev/null 2>&1 \
    || docker network create openshell-docker >/dev/null
  OPENSHELL_DOCKER_BRIDGE_IP=$(docker network inspect openshell-docker \
    --format '{{(index .IPAM.Config 0).Gateway}}')
  [[ "$OPENSHELL_DOCKER_BRIDGE_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
    || error "OpenShell Docker network has no IPv4 bridge gateway."
fi

# ─── Content hash of Docker build inputs (file contents, ignores mtime) ──────
# Used to skip docker build / containerd import when nothing relevant changed.
build_inputs_hash() {
  find "$@" -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' \
    -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -d' ' -f1
}

# ─── Agent image: build + import into k3s containerd ─────────────────────────
# k3s uses its own containerd (not the host Docker). kubelet resolves Pod images
# from the `k8s.io` containerd namespace, so the image MUST be imported there
# (combined with sandboxImagePullPolicy=IfNotPresent, sandbox Pods then use the
# local image without any registry pull).
#
# Both the build AND the slow `docker save | ctr import` are skipped when the
# agent build inputs are unchanged AND the image is present in host Docker and
# in k3s containerd (verifies real state, so a stale marker never mis-skips).
agent_image_present_in_k3s() {
  local probe_name="ve-agent-image-probe"
  local docker_id runtime_id
  docker_id=$(docker image inspect virtual-engineer-workspace:latest --format '{{.Id}}' 2>/dev/null) \
    || return 1
  KUBECONFIG="$K3S_KUBECONFIG" kubectl delete pod "$probe_name" \
    -n ve-agents --ignore-not-found >/dev/null 2>&1 || true
  if ! KUBECONFIG="$K3S_KUBECONFIG" kubectl run "$probe_name" -n ve-agents \
      --image=virtual-engineer-workspace:latest --image-pull-policy=Never \
      --restart=Never \
      --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65532,"runAsGroup":65532,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"ve-agent-image-probe","image":"virtual-engineer-workspace:latest","imagePullPolicy":"Never","command":["/bin/sh","-c","exit 0"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
      >/dev/null 2>&1; then
    return 1
  fi
  if KUBECONFIG="$K3S_KUBECONFIG" kubectl wait pod/"$probe_name" \
      -n ve-agents --for=jsonpath='{.status.phase}'=Succeeded --timeout=30s \
      >/dev/null 2>&1; then
    runtime_id=$(KUBECONFIG="$K3S_KUBECONFIG" kubectl get pod "$probe_name" \
      -n ve-agents -o jsonpath='{.status.containerStatuses[0].imageID}' 2>/dev/null || true)
  else
    runtime_id=""
  fi
  KUBECONFIG="$K3S_KUBECONFIG" kubectl delete pod "$probe_name" \
    -n ve-agents --ignore-not-found >/dev/null 2>&1 || true
  image_ids_match "$docker_id" "$runtime_id"
}

agent_image_present_in_runtime() {
  if [[ "$OPENSHELL_COMPUTE_DRIVER" == "docker" ]]; then
    docker image inspect virtual-engineer-workspace:latest >/dev/null 2>&1
  else
    agent_image_present_in_k3s
  fi
}

AGENT_HASH=$(build_inputs_hash Dockerfile.agent agent-worker)
AGENT_MARKER="${DATA_DIR}/.agent-image-hash"
if [[ "$(cat "$AGENT_MARKER" 2>/dev/null || true)" == "$AGENT_HASH" ]] \
   && agent_image_present_in_runtime; then
  info "Agent image up to date (sources unchanged, present in ${OPENSHELL_COMPUTE_DRIVER}) — skipping build."
else
  info "Building agent image..."
  docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
  if [[ "$OPENSHELL_COMPUTE_DRIVER" == "docker" ]]; then
    echo "$AGENT_HASH" > "$AGENT_MARKER"
  elif agent_image_present_in_k3s; then
    info "The exact agent image is already present in k3s; skipping import."
    echo "$AGENT_HASH" > "$AGENT_MARKER"
  else
    info "Importing agent image into k3s containerd (k8s.io namespace)..."
    if docker save virtual-engineer-workspace:latest | sudo k3s ctr -n k8s.io images import - >/dev/null; then
      echo "$AGENT_HASH" > "$AGENT_MARKER"
    else
    error "Could not import agent image into k3s."
    fi
  fi
fi

# ─── Orchestrator image (always includes the OpenShell CLI) ───────────────────
# Skip the build when its inputs (Dockerfile + src + agent-worker + prompts +
# package/tsconfig/vite files + the pinned OpenShell version) are unchanged and
# the image already exists. The build's own layer cache is a fallback, but
# skipping the invocation avoids buildkit's metadata/context overhead.
ORCH_HASH=$(printf '%s\n%s\n%s\n' "$OPENSHELL_VERSION" "$OPENSHELL_INSTALLER_SHA256" \
  "$(build_inputs_hash Dockerfile.orchestrator src agent-worker prompts \
      package.json package-lock.json tsconfig.json tsconfig.admin-ui.json vite.admin.config.ts)" \
  | sha256sum | cut -d' ' -f1)
ORCH_MARKER="${DATA_DIR}/.orchestrator-image-hash"
if [[ "$(cat "$ORCH_MARKER" 2>/dev/null || true)" == "$ORCH_HASH" ]] \
   && docker image inspect virtual-engineer:latest >/dev/null 2>&1; then
  info "Orchestrator image up to date (sources unchanged) — skipping build."
else
  info "Building orchestrator image with OpenShell CLI (${OPENSHELL_VERSION})..."
  docker build -f Dockerfile.orchestrator \
    --build-arg INSTALL_OPENSHELL=true \
    --build-arg OPENSHELL_VERSION="$OPENSHELL_VERSION" \
    --build-arg OPENSHELL_INSTALLER_SHA256="$OPENSHELL_INSTALLER_SHA256" \
    -t virtual-engineer:latest .
  echo "$ORCH_HASH" > "$ORCH_MARKER"
fi

if [[ "$OPENSHELL_COMPUTE_DRIVER" == "kubernetes" ]]; then
# ─── Locate helm (user-local install or system) ──────────────────────────────
HELM_BIN=""
for _h in "$HOME/.local/bin/helm" /usr/local/bin/helm /usr/bin/helm; do
  if [[ -x "$_h" ]]; then HELM_BIN="$_h"; break; fi
done
if [[ -z "$HELM_BIN" ]]; then
  info "helm not found — downloading to ~/.local/bin/helm..."
  mkdir -p "$HOME/.local/bin"
  HELM_VER=v3.17.3
  HELM_SHA256=ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd
  HELM_ARCHIVE=$(mktemp)
  curl -fsSL -o "$HELM_ARCHIVE" "https://get.helm.sh/helm-${HELM_VER}-linux-amd64.tar.gz"
  echo "$HELM_SHA256  $HELM_ARCHIVE" | sha256sum --check --status \
    || error "Helm archive checksum verification failed."
  tar xzf "$HELM_ARCHIVE" -C /tmp/ && cp /tmp/linux-amd64/helm "$HOME/.local/bin/helm"
  rm -f "$HELM_ARCHIVE"
  HELM_BIN="$HOME/.local/bin/helm"
  info "helm $(${HELM_BIN} version --short) installed."
fi

# ─── OpenShell gateway — deployed via Helm into k3s ──────────────────────────
# The gateway service is ClusterIP-only. A managed port-forward exposes it to
# the host-side Docker orchestrator on loopback without opening a node port.
if [[ ! -f "$K3S_KUBECONFIG" ]]; then
  error "k3s kubeconfig not found at ${K3S_KUBECONFIG}."
fi

# ─── Agent Sandbox CRDs + controller (prerequisite for the k8s driver) ───────
# The OpenShell kubernetes driver reconciles `sandboxes.agents.x-k8s.io` custom
# resources, which are defined by the upstream kubernetes-sigs/agent-sandbox
# project. Install the CRDs + controller before deploying the gateway.
# Skip when they are already present (idempotent, saves the download + wait).
INSTALLED_AGENT_SANDBOX_IMAGE=$(KUBECONFIG="$K3S_KUBECONFIG" kubectl get deployment \
  agent-sandbox-controller -n agent-sandbox-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
if KUBECONFIG="$K3S_KUBECONFIG" kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
   && [[ "$INSTALLED_AGENT_SANDBOX_IMAGE" == *":${AGENT_SANDBOX_VERSION}" ]]; then
  info "Agent Sandbox ${AGENT_SANDBOX_VERSION} already installed — skipping."
else
  info "Installing Kubernetes Agent Sandbox CRDs + controller..."
  AGENT_SANDBOX_MANIFEST="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
  AGENT_SANDBOX_MANIFEST_FILE=$(mktemp)
  trap 'rm -f "$AGENT_SANDBOX_MANIFEST_FILE"' EXIT
  curl -fsSL "$AGENT_SANDBOX_MANIFEST" -o "$AGENT_SANDBOX_MANIFEST_FILE" \
    || error "Could not download Agent Sandbox ${AGENT_SANDBOX_VERSION} manifest."
  echo "${AGENT_SANDBOX_MANIFEST_SHA256}  ${AGENT_SANDBOX_MANIFEST_FILE}" | sha256sum --check --status \
    || error "Agent Sandbox manifest checksum verification failed."
  KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f "$AGENT_SANDBOX_MANIFEST_FILE" >/dev/null 2>&1 \
    || error "Could not apply Agent Sandbox manifest."
  rm -f "$AGENT_SANDBOX_MANIFEST_FILE"
  trap - EXIT
  KUBECONFIG="$K3S_KUBECONFIG" kubectl wait \
    --for=condition=available deployment/agent-sandbox-controller \
    -n agent-sandbox-system --timeout=120s >/dev/null 2>&1 \
    || error "Agent Sandbox controller did not become ready."
fi

# ─── OpenShell gateway (Helm) ────────────────────────────────────────────────
# Skip the Helm upgrade + readiness wait when the release is already deployed
# with the current values file AND its pod is Ready (verifies real state, so a
# stale marker never causes an incorrect skip).
OPENSHELL_VALUES_FILE="$ROOT_DIR/deploy/k8s/openshell-gateway-values.yaml"
OPENSHELL_VALUES_HASH=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$OPENSHELL_CHART_DIGEST" "$OPENSHELL_OIDC_ISSUER" \
  "$OPENSHELL_OIDC_CLIENT_ID" "$OPENSHELL_OIDC_AUDIENCE" \
  "$OPENSHELL_OIDC_CA_CONFIG_MAP" \
  "$(sha256sum "$OPENSHELL_VALUES_FILE" | cut -d' ' -f1)" | sha256sum | cut -d' ' -f1)
OPENSHELL_HELM_MARKER="${DATA_DIR}/.openshell-helm-values"
if KUBECONFIG="$K3S_KUBECONFIG" "$HELM_BIN" status openshell -n virtual-engineer >/dev/null 2>&1 \
   && [[ "$(cat "$OPENSHELL_HELM_MARKER" 2>/dev/null || true)" == "$OPENSHELL_VALUES_HASH" ]] \
   && KUBECONFIG="$K3S_KUBECONFIG" kubectl wait --for=condition=ready pod \
        -l 'app.kubernetes.io/name=openshell' -n virtual-engineer --timeout=5s >/dev/null 2>&1; then
  info "OpenShell gateway already deployed with current values — skipping Helm upgrade."
else
  info "Deploying OpenShell gateway via Helm into k3s (namespace: virtual-engineer)..."
  KUBECONFIG="$K3S_KUBECONFIG" "$HELM_BIN" upgrade --install openshell \
    "oci://ghcr.io/nvidia/openshell/helm-chart@${OPENSHELL_CHART_DIGEST}" \
    --namespace virtual-engineer --create-namespace \
    --wait --timeout 180s \
    -f "$OPENSHELL_VALUES_FILE" \
    --set-string "server.oidc.issuer=${OPENSHELL_OIDC_ISSUER}" \
    --set-string "server.oidc.audience=${OPENSHELL_OIDC_AUDIENCE}" \
    --set-string "server.oidc.caConfigMapName=${OPENSHELL_OIDC_CA_CONFIG_MAP}" \
    || error "Helm deployment of OpenShell gateway failed."
  echo "$OPENSHELL_VALUES_HASH" > "$OPENSHELL_HELM_MARKER"

  info "Waiting for OpenShell gateway pod to become Ready..."
  if KUBECONFIG="$K3S_KUBECONFIG" kubectl wait \
      --for=condition=ready pod \
      -l 'app.kubernetes.io/name=openshell' \
      -n virtual-engineer \
      --timeout=120s 2>/dev/null; then
    info "OpenShell gateway is running."
  else
    warn "Gateway pod did not become Ready in time — sandbox creation will fail."
    warn "Check: KUBECONFIG=$K3S_KUBECONFIG kubectl -n virtual-engineer get pods"
  fi
fi

# Refresh the loopback-only gateway tunnel used by the Docker orchestrator.
stop_managed_openshell_port_forward \
  "$OPENSHELL_PORT_FORWARD_PID" "$OPENSHELL_GW_LOCAL_PORT" "$ROOT_DIR" \
  || error "Could not stop the previous OpenShell gateway tunnel."
OPENSHELL_SERVICE=$(KUBECONFIG="$K3S_KUBECONFIG" kubectl get service \
  -n virtual-engineer -l 'app.kubernetes.io/name=openshell' \
  -o jsonpath='{.items[0].metadata.name}')
[[ -n "$OPENSHELL_SERVICE" ]] || error "OpenShell gateway service not found."
KUBECONFIG="$K3S_KUBECONFIG" kubectl port-forward \
  -n virtual-engineer --address 127.0.0.1 \
  "service/${OPENSHELL_SERVICE}" "${OPENSHELL_GW_LOCAL_PORT}:8080" \
  >"${DATA_DIR}/openshell-port-forward.log" 2>&1 &
_port_forward_pid=$!
echo "$_port_forward_pid" > "$OPENSHELL_PORT_FORWARD_PID"
if ! wait_for_tcp_listener "$_port_forward_pid" 127.0.0.1 "$OPENSHELL_GW_LOCAL_PORT" 30; then
  warn "OpenShell port-forward did not bind 127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}."
  cat "${DATA_DIR}/openshell-port-forward.log" >&2 2>/dev/null || true
  kill "$_port_forward_pid" 2>/dev/null || true
  rm -f "$OPENSHELL_PORT_FORWARD_PID"
  error "Could not establish the OpenShell gateway tunnel."
fi

OPENSHELL_GATEWAY_ENDPOINT="https://127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}"
OPENSHELL_MTLS_DIR="${OPENSHELL_CONFIG_DIR}/openshell/gateways/${OPENSHELL_GATEWAY_NAME}/mtls"
reclaim_root_owned_tree "${OPENSHELL_CONFIG_DIR}/openshell"
install -d -m 0700 "$OPENSHELL_MTLS_DIR"
for _tls_key in ca.crt tls.crt tls.key; do
  KUBECONFIG="$K3S_KUBECONFIG" kubectl get secret openshell-client-tls \
    -n virtual-engineer -o "jsonpath={.data.${_tls_key//./\\.}}" \
    | base64 --decode > "${OPENSHELL_MTLS_DIR}/${_tls_key}" \
    || error "Could not export OpenShell client TLS ${_tls_key}."
done
chmod 0600 "${OPENSHELL_MTLS_DIR}/ca.crt" "${OPENSHELL_MTLS_DIR}/tls.crt" "${OPENSHELL_MTLS_DIR}/tls.key"

# The Kubernetes driver mounts this client bundle into sandbox supervisors.
# Secrets are namespace-scoped, so reconcile the Helm-generated bundle into
# the sandbox namespace after every install or certificate rotation.
KUBECONFIG="$K3S_KUBECONFIG" kubectl create secret generic openshell-client-tls \
  -n ve-agents \
  --type=kubernetes.io/tls \
  --from-file="ca.crt=${OPENSHELL_MTLS_DIR}/ca.crt" \
  --from-file="tls.crt=${OPENSHELL_MTLS_DIR}/tls.crt" \
  --from-file="tls.key=${OPENSHELL_MTLS_DIR}/tls.key" \
  --dry-run=client -o yaml \
  | KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f - >/dev/null \
  || error "Could not reconcile OpenShell client TLS into the ve-agents namespace."

if ! docker run --rm --network host \
  "${OIDC_DOCKER_HOST_ARGS[@]}" \
    -e OPENSHELL_OIDC_CLIENT_SECRET \
    -e "OPENSHELL_GATEWAY_NAME=${OPENSHELL_GATEWAY_NAME}" \
    -e "OPENSHELL_GATEWAY_ENDPOINT=${OPENSHELL_GATEWAY_ENDPOINT}" \
    -e "OPENSHELL_OIDC_ISSUER=${OPENSHELL_OIDC_ISSUER}" \
    -e "OPENSHELL_OIDC_CLIENT_ID=${OPENSHELL_OIDC_CLIENT_ID}" \
    -e "OPENSHELL_OIDC_AUDIENCE=${OPENSHELL_OIDC_AUDIENCE}" \
    -e XDG_CONFIG_HOME=/ve-openshell-config \
    -v "${OPENSHELL_CONFIG_DIR}:/ve-openshell-config:rw,Z" \
    virtual-engineer:latest sh -c \
      'attempt=0
       while :; do
         openshell gateway remove "$OPENSHELL_GATEWAY_NAME" >/dev/null 2>&1 || true
         output=$(openshell gateway add "$OPENSHELL_GATEWAY_ENDPOINT" --local \
           --name "$OPENSHELL_GATEWAY_NAME" --oidc-issuer "$OPENSHELL_OIDC_ISSUER" \
           --oidc-client-id "$OPENSHELL_OIDC_CLIENT_ID" --oidc-audience "$OPENSHELL_OIDC_AUDIENCE" 2>&1)
         # gateway add exits 0 even when login fails and it rolls the
         # registration back, so the stored profile is the only success signal.
         openshell gateway info -g "$OPENSHELL_GATEWAY_NAME" >/dev/null 2>&1 && break
         attempt=$((attempt + 1))
         if [ "$attempt" -ge 20 ]; then printf "%s\n" "$output" >&2; exit 1; fi
         sleep 1
       done
       OPENSHELL_GATEWAY="$OPENSHELL_GATEWAY_NAME" openshell status'; then
  kill "$_port_forward_pid" 2>/dev/null || true
  rm -f "$OPENSHELL_PORT_FORWARD_PID"
  error "OpenShell gateway tunnel or mTLS authentication failed. See ${DATA_DIR}/openshell-port-forward.log"
fi
else
  stop_managed_openshell_port_forward \
    "$OPENSHELL_PORT_FORWARD_PID" "$OPENSHELL_GW_LOCAL_PORT" "$ROOT_DIR" \
    || error "Could not stop the previous OpenShell gateway tunnel."
  OPENSHELL_GATEWAY_CONFIG_DIR="${DATA_DIR}/openshell-gateway"
  OPENSHELL_GATEWAY_STATE_DIR="${DATA_DIR}/openshell-gateway-state"
  OPENSHELL_GATEWAY_PKI_DIR="${OPENSHELL_GATEWAY_STATE_DIR}/pki"
  ensure_dir "$OPENSHELL_GATEWAY_CONFIG_DIR" 700
  ensure_dir "$OPENSHELL_GATEWAY_STATE_DIR" 700
  info "Reconciling OpenShell sandbox JWT signing keys..."
  docker run --rm \
    --user 0 \
    --security-opt label=disable \
    -v "${OPENSHELL_GATEWAY_STATE_DIR}:${OPENSHELL_GATEWAY_STATE_DIR}" \
    -e "XDG_CONFIG_HOME=${OPENSHELL_GATEWAY_STATE_DIR}/certgen-config" \
    -e "HOME=${OPENSHELL_GATEWAY_STATE_DIR}" \
    "$OPENSHELL_GATEWAY_IMAGE" generate-certs --output-dir "$OPENSHELL_GATEWAY_PKI_DIR" >/dev/null \
    || error "Could not generate OpenShell sandbox JWT signing keys."
  OPENSHELL_GATEWAY_CONFIG_FILE="${OPENSHELL_GATEWAY_CONFIG_DIR}/gateway.toml"
  write_docker_gateway_config \
    "$OPENSHELL_GATEWAY_CONFIG_FILE" \
    "$OPENSHELL_OIDC_ISSUER" \
    "virtual-engineer-workspace:latest" \
    "$OPENSHELL_SUPERVISOR_IMAGE" \
    "$OPENSHELL_GW_LOCAL_PORT" \
    "${OPENSHELL_GATEWAY_PKI_DIR}/jwt"

  OPENSHELL_GATEWAY_JWT_HASH=$(docker run --rm \
    --user 0 \
    --security-opt label=disable \
    -v "${OPENSHELL_GATEWAY_PKI_DIR}/jwt:/jwt:ro" \
    --entrypoint sha256sum \
    virtual-engineer:latest /jwt/public.pem /jwt/kid) \
    || error "Could not hash OpenShell sandbox JWT public identity."
  OPENSHELL_GATEWAY_CONFIG_HASH=$(printf '%s\n%s\n%s\n%s\n' \
    "$OPENSHELL_GATEWAY_IMAGE" \
    "$OPENSHELL_DOCKER_BRIDGE_IP" \
    "$(sha256sum "$OPENSHELL_GATEWAY_CONFIG_FILE" | cut -d' ' -f1)" \
    "$OPENSHELL_GATEWAY_JWT_HASH" \
    | sha256sum | cut -d' ' -f1)
  OPENSHELL_GATEWAY_CONFIG_MARKER="${DATA_DIR}/.openshell-docker-gateway-config"
  _gateway_running=$(docker inspect --format='{{.State.Running}}' ve-openshell-gateway 2>/dev/null || true)
  _gateway_image=$(docker inspect --format='{{.Config.Image}}' ve-openshell-gateway 2>/dev/null || true)
  if [[ "$_gateway_running" == "true" ]] \
     && [[ "$_gateway_image" == "$OPENSHELL_GATEWAY_IMAGE" ]] \
     && [[ "$(cat "$OPENSHELL_GATEWAY_CONFIG_MARKER" 2>/dev/null || true)" == "$OPENSHELL_GATEWAY_CONFIG_HASH" ]]; then
    info "OpenShell Docker gateway is already running with the current configuration."
  else
    docker rm -f ve-openshell-gateway >/dev/null 2>&1 || true
    info "Starting OpenShell gateway with the Docker compute driver..."
    docker run -d \
      --name ve-openshell-gateway \
      --restart unless-stopped \
      --user 0 \
      --security-opt label=disable \
      --network ve-openshell-control \
      --add-host host.openshell.internal:host-gateway \
      -p "127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}:${OPENSHELL_GW_LOCAL_PORT}" \
      -p "${OPENSHELL_DOCKER_BRIDGE_IP}:${OPENSHELL_GW_LOCAL_PORT}:${OPENSHELL_GW_LOCAL_PORT}" \
      -p "127.0.0.1:$((OPENSHELL_GW_LOCAL_PORT + 1)):$((OPENSHELL_GW_LOCAL_PORT + 1))" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "${OPENSHELL_GATEWAY_STATE_DIR}:${OPENSHELL_GATEWAY_STATE_DIR}" \
      -v "${OPENSHELL_GATEWAY_CONFIG_FILE}:/etc/openshell/gateway.toml:ro" \
      -e OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml \
      -e "OPENSHELL_DB_URL=sqlite:${OPENSHELL_GATEWAY_STATE_DIR}/gateway.db?mode=rwc" \
      -e "XDG_DATA_HOME=${OPENSHELL_GATEWAY_STATE_DIR}" \
      -e "HOME=${OPENSHELL_GATEWAY_STATE_DIR}" \
      "$OPENSHELL_GATEWAY_IMAGE" --config /etc/openshell/gateway.toml >/dev/null
    echo "$OPENSHELL_GATEWAY_CONFIG_HASH" > "$OPENSHELL_GATEWAY_CONFIG_MARKER"
    chmod 600 "$OPENSHELL_GATEWAY_CONFIG_MARKER"
  fi

  _gateway_pid=$(docker inspect --format='{{.State.Pid}}' ve-openshell-gateway 2>/dev/null || true)
  _gateway_up=$(docker inspect --format='{{.State.Running}}' ve-openshell-gateway 2>/dev/null || true)
  # The published port answers as soon as the container exists, so the log line
  # is the only proof that the gateway process itself is accepting connections.
  if [[ ! "$_gateway_pid" =~ ^[1-9][0-9]*$ ]] || [[ "$_gateway_up" != "true" ]] \
    || ! wait_for_container_log ve-openshell-gateway "Server listening" 60 \
    || ! wait_for_tcp_port 127.0.0.1 "$OPENSHELL_GW_LOCAL_PORT" 30; then
    docker logs ve-openshell-gateway >&2 2>/dev/null || true
    error "OpenShell Docker gateway did not become ready."
  fi

  OPENSHELL_GATEWAY_ENDPOINT="http://127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}"
  OPENSHELL_CLI_RUN_ARGS=(
    --rm --network host
    "${OIDC_DOCKER_HOST_ARGS[@]}"
    -e OPENSHELL_OIDC_CLIENT_SECRET
    -e "OPENSHELL_GATEWAY_NAME=${OPENSHELL_GATEWAY_NAME}"
    -e "OPENSHELL_GATEWAY_ENDPOINT=${OPENSHELL_GATEWAY_ENDPOINT}"
    -e "OPENSHELL_OIDC_ISSUER=${OPENSHELL_OIDC_ISSUER}"
    -e "OPENSHELL_OIDC_CLIENT_ID=${OPENSHELL_OIDC_CLIENT_ID}"
    -e "OPENSHELL_OIDC_AUDIENCE=${OPENSHELL_OIDC_AUDIENCE}"
    -e XDG_CONFIG_HOME=/ve-openshell-config
    -v "${OPENSHELL_CONFIG_DIR}:/ve-openshell-config:rw,Z"
  )
  if ! docker run "${OPENSHELL_CLI_RUN_ARGS[@]}" virtual-engineer:latest sh -c \
        'attempt=0
         while :; do
           openshell gateway remove "$OPENSHELL_GATEWAY_NAME" >/dev/null 2>&1 || true
           output=$(openshell gateway add "$OPENSHELL_GATEWAY_ENDPOINT" --local \
             --name "$OPENSHELL_GATEWAY_NAME" --oidc-issuer "$OPENSHELL_OIDC_ISSUER" \
             --oidc-client-id "$OPENSHELL_OIDC_CLIENT_ID" --oidc-audience "$OPENSHELL_OIDC_AUDIENCE" 2>&1)
           # gateway add exits 0 even when login fails and it rolls the
           # registration back, so the stored profile is the only success signal.
           openshell gateway info -g "$OPENSHELL_GATEWAY_NAME" >/dev/null 2>&1 && break
           attempt=$((attempt + 1))
           if [ "$attempt" -ge 20 ]; then printf "%s\n" "$output" >&2; exit 1; fi
           sleep 1
         done'; then
    error "OpenShell Docker gateway OIDC authentication failed. Check: docker logs ve-openshell-gateway"
  fi
  if ! docker run "${OPENSHELL_CLI_RUN_ARGS[@]}" virtual-engineer:latest sh -c \
        'attempt=0
         while :; do
           output=$(OPENSHELL_GATEWAY="$OPENSHELL_GATEWAY_NAME" openshell status 2>&1) \
             && { printf "%s\n" "$output"; break; }
           attempt=$((attempt + 1))
           if [ "$attempt" -ge 30 ]; then printf "%s\n" "$output" >&2; exit 1; fi
           sleep 1
         done'; then
    docker logs ve-openshell-gateway >&2 2>/dev/null || true
    error "OpenShell Docker gateway did not accept an authenticated connection at ${OPENSHELL_GATEWAY_ENDPOINT}."
  fi
fi

OPENSHELL_GATEWAY_ARGS=(
  -e OPENSHELL_OIDC_CLIENT_SECRET
  -e "OPENSHELL_GATEWAY=${OPENSHELL_GATEWAY_NAME}"
  -e "OPENSHELL_GATEWAY_ENDPOINT=${OPENSHELL_GATEWAY_ENDPOINT}"
  -e XDG_CONFIG_HOME=/ve-openshell-config
  -v "${OPENSHELL_CONFIG_DIR}:/ve-openshell-config:rw,Z"
)

# ─── Idempotent container restart ─────────────────────────────────────────────
# The tunnel is reconciled first so rerunning this script repairs a dead
# gateway connection even when the current orchestrator image is still running.
SSH_AGENT_ARGS=()
if [[ -n "${SSH_AUTH_SOCK:-}" && -S "$SSH_AUTH_SOCK" ]]; then
  info "SSH agent detected at $SSH_AUTH_SOCK — forwarding into container."
  SSH_AGENT_ARGS=(-v "$SSH_AUTH_SOCK:$SSH_AUTH_SOCK" -e "SSH_AUTH_SOCK=$SSH_AUTH_SOCK")
else
  warn "No SSH agent socket found (SSH_AUTH_SOCK not set or not a socket). Agent-based SSH auth will not be available."
fi

RESTORE_DOCKER_ARGS=()
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  RESTORE_DOCKER_ARGS=(
    --mount "type=bind,source=${RESTORE_ARCHIVE},target=/app/restore-backup,readonly"
    -e "VE_RESTORE_FROM=/app/restore-backup"
  )
  if [[ "$RESTORE_FORCE" == "true" ]]; then
    RESTORE_DOCKER_ARGS+=(-e "VE_RESTORE_FORCE=true")
  fi
fi

DOCKER_RUN_ARGS=(
  -d
  --name ve-orchestrator
  --restart unless-stopped
  --network host
  "${OIDC_DOCKER_HOST_ARGS[@]}"
  --env-file "$ROOT_DIR/.env"
  -e ADMIN_AUTH_SECRET
  -e "TZ=$ORCHESTRATOR_TIMEZONE"
  -e "BACKUP_ACCESS_GID=$BACKUP_ACCESS_GID"
  -e DATABASE_PATH=/app/data/virtual-engineer.db
  "${RESTORE_DOCKER_ARGS[@]}"
  "${BACKUP_KEYRING_DOCKER_ARGS[@]}"
  -e GH_CONFIG_DIR=/ve-gh
  --security-opt label:disable
  -v /etc/localtime:/etc/localtime:ro
  -v "$DATA_DIR:/app/data:Z"
  -v "$HOME/.config/gh:/ve-gh:ro"
  --tmpfs "/tmp/ve-review-diffs:rw,size=${REVIEW_DIFF_TMPFS_SIZE}"
  "${SSH_AGENT_ARGS[@]}"
  "${OPENSHELL_GATEWAY_ARGS[@]}"
)

LATEST_ID=$(docker inspect --format='{{.Id}}' virtual-engineer:latest 2>/dev/null || true)
RUNNING_ID=$(docker inspect --format='{{.Image}}' ve-orchestrator 2>/dev/null || true)
IS_RUNNING=$(docker inspect --format='{{.State.Running}}' ve-orchestrator 2>/dev/null || true)
OIDC_SECRET_LEN=${#OPENSHELL_OIDC_CLIENT_SECRET}
ADMIN_AUTH_SECRET_HASH=$(printf '%s' "${ADMIN_AUTH_SECRET:-}" | sha256sum | awk '{ print $1 }')
RUN_CONFIG_HASH=$(run_config_hash "$ROOT_DIR/.env" "${DOCKER_RUN_ARGS[@]}" \
  "oidc-secret-len=${OIDC_SECRET_LEN}" "admin-auth-secret-sha256=${ADMIN_AUTH_SECRET_HASH}")
RUN_CONFIG_MARKER="${DATA_DIR}/.orchestrator-run-config-hash"
STORED_RUN_CONFIG_HASH=$(cat "$RUN_CONFIG_MARKER" 2>/dev/null || true)

if [[ -n "$RESTORE_ARCHIVE" ]]; then
  info "Stopping the existing ve-orchestrator before restore..."
  if [[ -n "$RUNNING_ID" ]]; then
    docker rm -f ve-orchestrator
  fi
  RESTORE_REMAINING_ID=$(docker inspect --format='{{.Id}}' ve-orchestrator 2>/dev/null || true)
  [[ -z "$RESTORE_REMAINING_ID" ]] || error "Could not stop the existing ve-orchestrator before restore."
elif should_reuse_container \
  "$IS_RUNNING" "$RUNNING_ID" "$LATEST_ID" "$STORED_RUN_CONFIG_HASH" "$RUN_CONFIG_HASH"; then
  info "ve-orchestrator is already running the latest image; gateway tunnel refreshed."
  info "Logs : docker logs -f ve-orchestrator"
  exit 0
elif [[ -n "$RUNNING_ID" ]]; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator
fi

info "Starting ve-orchestrator..."
docker run "${DOCKER_RUN_ARGS[@]}" virtual-engineer:latest
echo "$RUN_CONFIG_HASH" > "$RUN_CONFIG_MARKER"
chmod 600 "$RUN_CONFIG_MARKER"

info "ve-orchestrator started."

info "Admin UI : http://127.0.0.1:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"

