#!/usr/bin/env bash

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