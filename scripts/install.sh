#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY_URL="${VE_REPOSITORY_URL:-https://github.com/savoirfairelinux/virtual-engineer.git}"
REF="${VE_REF:-main}"
EXPECTED_COMMIT="${VE_EXPECTED_COMMIT:-}"
CHECKOUT_NAME="virtual-engineer"
INSTALL_DIR=""
START_ARGS=()
TEMP_ENV_FILE=""
TEMP_SECRET_FILE=""

info() {
  printf '[INFO]  %s\n' "$*"
}

warn() {
  printf '[WARN]  %s\n' "$*" >&2
}

error() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Virtual Engineer bootstrap installer

Usage:
  curl -fsSL https://virtual-engineer.dev/install.sh | bash
  bash scripts/install.sh [installer options] [-- start.sh options]

The installer clones into ./virtual-engineer, or reuses the current directory
when it already is a Virtual Engineer checkout. Set VE_REF to select a branch
or release tag, and VE_EXPECTED_COMMIT to verify the resolved 40-character
commit.
Pass start.sh options after --, for example:
  curl -fsSL https://virtual-engineer.dev/install.sh | bash -s -- --no-k3s-install
EOF
}

cleanup() {
  if [[ -n "$TEMP_ENV_FILE" ]]; then
    rm -f "$TEMP_ENV_FILE"
  fi
  if [[ -n "$TEMP_SECRET_FILE" ]]; then
    rm -f "$TEMP_SECRET_FILE"
  fi
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --ref)
      [[ $# -ge 2 ]] || error "--ref requires a branch or release tag."
      REF="$2"
      shift 2
      ;;
    --ref=*)
      REF="${1#*=}"
      shift
      ;;
    --)
      shift
      START_ARGS+=("$@")
      break
      ;;
    *)
      START_ARGS+=("$1")
      shift
      ;;
  esac
done

[[ -n "$REF" ]] || error "VE_REF must not be empty."
[[ "$REF" != -* ]] || error "VE_REF must not start with '-'."
[[ "$REF" != *$'\n'* && "$REF" != *$'\r'* && "$REF" != *$'\t'* ]] \
  || error "VE_REF must not contain control characters."
if [[ -n "$EXPECTED_COMMIT" ]] \
  && [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  error "VE_EXPECTED_COMMIT must be a 40-character lowercase Git commit."
fi
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  if [[ -n "$EXPECTED_COMMIT" && "$EXPECTED_COMMIT" != "$REF" ]]; then
    error "VE_REF and VE_EXPECTED_COMMIT identify different commits."
  fi
  EXPECTED_COMMIT="$REF"
fi
[[ "$REPOSITORY_URL" != -* ]] \
  || error "The repository URL must not start with '-'."
[[ "$REPOSITORY_URL" != *$'\n'* && "$REPOSITORY_URL" != *$'\r'* && "$REPOSITORY_URL" != *$'\t'* ]] \
  || error "The repository URL must not contain control characters."
if [[ -n "${VE_REPOSITORY_URL:-}" ]] \
  && [[ "${VE_ALLOW_CUSTOM_REPOSITORY:-}" != "true" ]]; then
  error "VE_REPOSITORY_URL is restricted to test or explicitly trusted use; set VE_ALLOW_CUSTOM_REPOSITORY=true to override."
fi
case "$REPOSITORY_URL" in
  ext::*|ssh+exec::*|git+ssh::*|git://*)
    error "Unsupported repository transport: ${REPOSITORY_URL%%:*}:"
    ;;
esac

for command_name in git curl openssl docker; do
  command -v "$command_name" >/dev/null 2>&1 \
    || error "Required command not found: ${command_name}. Install it and retry."
done

docker info >/dev/null 2>&1 \
  || error "The Docker daemon is not accessible. Start Docker and retry."

assert_safe_directory() {
  local directory="$1"
  local mode owner
  owner="$(stat -c '%u' "$directory")" \
    || error "Could not inspect installation directory: ${directory}"
  mode="$(stat -c '%a' "$directory")" \
    || error "Could not inspect installation directory permissions: ${directory}"
  [[ "$owner" == "$(id -u)" ]] \
    || error "Installation directory is not owned by the current user: ${directory}"
  if (( (8#$mode & 8#0022) != 0 )); then
    warn "Installation directory is group/world-writable: ${directory}"
  fi
}

is_virtual_engineer_checkout() {
  local directory="$1"
  [[ -e "$directory/.git" && ! -L "$directory/.git" ]] \
    && [[ -f "$directory/.env.example" && ! -L "$directory/.env.example" ]] \
    && [[ -f "$directory/scripts/start.sh" && ! -L "$directory/scripts/start.sh" ]]
}

is_empty_directory() {
  local directory="$1"
  local entry
  for entry in "$directory"/.[!.]* "$directory"/..?* "$directory"/*; do
    if [[ -e "$entry" || -L "$entry" ]]; then
      return 1
    fi
  done
  return 0
}

WORK_DIR="$(pwd -P)" || error "Could not resolve the current directory."
if is_virtual_engineer_checkout "$WORK_DIR"; then
  INSTALL_DIR="$WORK_DIR"
else
  INSTALL_DIR="${WORK_DIR}/${CHECKOUT_NAME}"
fi

if [[ ! -e "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR" || error "Could not create installation directory: ${INSTALL_DIR}"
fi
[[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]] \
  || error "Installation path is not a real directory: ${INSTALL_DIR}"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"

assert_safe_directory "$INSTALL_DIR"

clone_repository() {
  if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    git init "$INSTALL_DIR" >/dev/null \
      || error "Could not initialize the installation directory."
    git -C "$INSTALL_DIR" remote add origin "$REPOSITORY_URL" \
      || error "Could not configure the repository remote."
    git -C "$INSTALL_DIR" -c protocol.ext.allow=never -c protocol.file.allow=always \
      fetch --depth 1 origin "$REF" >/dev/null \
      || error "Could not fetch the requested commit ${REF}."
    git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD >/dev/null \
      || error "Could not check out the requested commit ${REF}."
    return
  fi
  git -c protocol.ext.allow=never -c protocol.file.allow=always \
    clone --depth 1 --branch "$REF" -- "$REPOSITORY_URL" "$INSTALL_DIR" \
    || error "Could not clone Virtual Engineer ref ${REF}."
}

if is_virtual_engineer_checkout "$INSTALL_DIR"; then
  info "Using existing Virtual Engineer checkout at ${INSTALL_DIR}."
elif is_empty_directory "$INSTALL_DIR"; then
  info "Cloning Virtual Engineer (${REF}) into ${INSTALL_DIR}..."
  clone_repository
  is_virtual_engineer_checkout "$INSTALL_DIR" \
    || error "The cloned repository is missing the Virtual Engineer startup files."
else
  error "Installation directory already exists and is not a Virtual Engineer checkout: ${INSTALL_DIR}. Remove it or run the installer from another directory."
fi

verify_checkout() {
  local root actual
  root="$(git -C "$INSTALL_DIR" rev-parse --show-toplevel 2>/dev/null)" \
    || error "The installation directory is not a valid Git worktree."
  [[ "$root" == "$INSTALL_DIR" ]] \
    || error "The Git worktree root does not match the installation directory."
  actual="$(git -C "$INSTALL_DIR" rev-parse --verify HEAD^{commit} 2>/dev/null)" \
    || error "The installation checkout has no valid commit."
  [[ "$actual" =~ ^[0-9a-f]{40}$ ]] \
    || error "The installation checkout resolved to an invalid commit."
  if [[ -n "$EXPECTED_COMMIT" && "$actual" != "$EXPECTED_COMMIT" ]]; then
    error "The checkout resolved to ${actual}, expected ${EXPECTED_COMMIT}."
  fi
  if [[ -z "$EXPECTED_COMMIT" && ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    warn "Ref ${REF} is mutable; set VE_EXPECTED_COMMIT to pin the checkout."
  fi
}

verify_checkout

ENV_FILE="${INSTALL_DIR}/.env"
ENV_EXAMPLE="${INSTALL_DIR}/.env.example"
[[ -f "$ENV_EXAMPLE" && ! -L "$ENV_EXAMPLE" ]] \
  || error "Missing regular .env.example in ${INSTALL_DIR}."
if [[ -L "$ENV_FILE" ]]; then
  error "Refusing to write through symlink: ${ENV_FILE}"
fi
if [[ ! -e "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE" \
    || error "Could not create ${ENV_FILE} from .env.example."
elif [[ ! -f "$ENV_FILE" ]]; then
  error "The .env path exists but is not a regular file: ${ENV_FILE}"
fi

has_admin_auth_secret() {
  local line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?ADMIN_AUTH_SECRET[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value#${value%%[![:space:]]*}}"
      value="${value%${value##*[![:space:]]}}"
      if [[ ${#value} -ge 2 ]] \
        && { [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]] \
          || [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; }; then
        value="${value:1:${#value}-2}"
      fi
      [[ -n "$value" && "$value" != \#* ]] && return 0
    fi
  done < "$ENV_FILE"
  return 1
}

if ! has_admin_auth_secret; then
  secret="$(openssl rand -hex 32 | tr -d '\r\n')" \
    || error "Could not generate ADMIN_AUTH_SECRET with OpenSSL."
  [[ "$secret" =~ ^[a-f0-9]{64}$ ]] \
    || error "OpenSSL returned an invalid ADMIN_AUTH_SECRET."
  TEMP_ENV_FILE="$(mktemp "${ENV_FILE}.install.XXXXXX")" \
    || error "Could not prepare a temporary environment file."
  TEMP_SECRET_FILE="$(mktemp "${ENV_FILE}.secret.XXXXXX")" \
    || error "Could not prepare a temporary secret file."
  chmod 600 "$TEMP_ENV_FILE"
  chmod 600 "$TEMP_SECRET_FILE"
  printf '%s\n' "$secret" > "$TEMP_SECRET_FILE"
  awk -v secret_file="$TEMP_SECRET_FILE" '
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
  ' "$ENV_FILE" > "$TEMP_ENV_FILE" \
    || error "Could not update ${ENV_FILE}."
  mv "$TEMP_ENV_FILE" "$ENV_FILE" \
    || error "Could not install the generated environment file."
  TEMP_ENV_FILE=""
  rm -f "$TEMP_SECRET_FILE"
  TEMP_SECRET_FILE=""
  unset secret
fi
chmod 600 "$ENV_FILE" || error "Could not protect ${ENV_FILE} with mode 0600."
assert_safe_directory "$INSTALL_DIR"

cd "$INSTALL_DIR"
info "Starting Virtual Engineer."
if [[ -r /dev/tty && ( -t 1 || -t 2 ) ]]; then
  exec bash "${INSTALL_DIR}/scripts/start.sh" "${START_ARGS[@]}" </dev/tty
fi
exec bash "${INSTALL_DIR}/scripts/start.sh" "${START_ARGS[@]}"
