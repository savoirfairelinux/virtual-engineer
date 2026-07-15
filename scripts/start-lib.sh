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