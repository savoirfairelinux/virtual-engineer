#!/usr/bin/env bash
# start.sh — One-shot setup + launch for Virtual Engineer.
#   Makes VE 100% functional from scratch: installs single-node k3s if missing,
#   builds the agent + orchestrator images (orchestrator includes the OpenShell
#   CLI), imports the agent image into k3s, starts the OpenShell gateway
#   (kubernetes driver) on k3s, and runs the orchestrator.
#   Agents run as ephemeral k3s Pods (upload -> exec -> download).
#
# Usage:
#   ./scripts/start.sh                     # full setup + launch
#   ./scripts/start.sh --no-k3s-install    # skip k3s auto-install (must already exist)
#
# Optional environment variables:
#   DATA_DIR       (default: ./data)
#   K3S_KUBECONFIG (default: /etc/rancher/k3s/k3s.yaml)  k3s admin kubeconfig path
#   OPENSHELL_OIDC_ISSUER external Keycloak realm issuer URL; omit with the
#     client secret to use the managed local Keycloak
#   OPENSHELL_OIDC_CLIENT_SECRET external confidential-client secret
#   OPENSHELL_OIDC_CLIENT_ID (default: openshell-ci)
#   OPENSHELL_OIDC_AUDIENCE (default: openshell-cli)
#   K3S_VERSION (default: v1.32.3+k3s1) fresh-install pin and minimum supported version
#   AGENT_SANDBOX_VERSION (default: v0.5.1) pinned controller manifest version
#   AGENT_SANDBOX_MANIFEST_SHA256 verified manifest digest for that version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/start-lib.sh"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

cd "$ROOT_DIR"
load_dotenv "$ROOT_DIR/.env"

# ─── Parse arguments ──────────────────────────────────────────────────────────
K3S_INSTALL=true
OPENSHELL_VERSION="v0.0.83"
OPENSHELL_INSTALLER_SHA256="c15d6cb8090e1c7c8d79a320b5bcbdaf1c15c2363942d81e84b56e03b836249e"
OPENSHELL_CHART_DIGEST="sha256:583bcd4eecf7a255c6201ba3b571b5207ee0f643630dfa4835e981e62c754cc7"
OPENSHELL_GATEWAY_NAME="${OPENSHELL_GATEWAY_NAME:-virtual-engineer}"
OPENSHELL_OIDC_ISSUER="${OPENSHELL_OIDC_ISSUER:-}"
OPENSHELL_OIDC_CLIENT_ID="${OPENSHELL_OIDC_CLIENT_ID:-openshell-ci}"
OPENSHELL_OIDC_AUDIENCE="${OPENSHELL_OIDC_AUDIENCE:-openshell-cli}"
OPENSHELL_OIDC_CA_CONFIG_MAP="${OPENSHELL_OIDC_CA_CONFIG_MAP:-}"
K3S_VERSION="${K3S_VERSION:-v1.32.3+k3s1}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.5.1}"
AGENT_SANDBOX_MANIFEST_SHA256="${AGENT_SANDBOX_MANIFEST_SHA256:-8cfdf0a878f66b91d2e7103e77859d1412d850ce3f5fe5c3fa134c36bd55504a}"

OIDC_MODE=$(oidc_mode "$OPENSHELL_OIDC_ISSUER" "${OPENSHELL_OIDC_CLIENT_SECRET:-}") \
  || error "Set both OpenShell OIDC values for an external provider, or leave both empty to use local Keycloak."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-k3s-install)
      K3S_INSTALL=false; shift ;;
    --help|-h)
      sed -n '2,17p' "$0"; exit 0 ;;
    *)
      error "Unknown argument: $1. Run ./scripts/start.sh --help" ;;
  esac
done
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
K3S_KUBECONFIG="${K3S_KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

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
OPENSHELL_CONFIG_DIR="${DATA_DIR}/openshell-cli-config"
ensure_dir "$OPENSHELL_CONFIG_DIR" 700

USER_KUBECONFIG="${DATA_DIR}/kubeconfig"
if [[ -r "$USER_KUBECONFIG" ]] \
  && KUBECONFIG="$USER_KUBECONFIG" kubectl get nodes >/dev/null 2>&1; then
  K3S_KUBECONFIG="$USER_KUBECONFIG"
fi

OIDC_DOCKER_HOST_ARGS=()
if [[ "$OIDC_MODE" == "local" ]]; then
  LOCAL_OIDC_DIR="${DATA_DIR}/local-oidc"
  ensure_dir "$LOCAL_OIDC_DIR" 700
  OPENSHELL_OIDC_ISSUER="http://keycloak.virtual-engineer.svc.cluster.local:8080/realms/openshell"
  info "No external OIDC configuration found; using managed local Keycloak."
fi

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
  OIDC_DOCKER_HOST_ARGS=(--add-host "keycloak.virtual-engineer.svc.cluster.local:${KEYCLOAK_CLUSTER_IP}")
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

AGENT_HASH=$(build_inputs_hash Dockerfile.agent agent-worker)
AGENT_MARKER="${DATA_DIR}/.agent-image-hash"
if [[ "$(cat "$AGENT_MARKER" 2>/dev/null || true)" == "$AGENT_HASH" ]] \
   && docker image inspect virtual-engineer-workspace:latest >/dev/null 2>&1 \
   && agent_image_present_in_k3s; then
  info "Agent image up to date (sources unchanged, present in k3s) — skipping build + import."
else
  info "Building agent image..."
  docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
  if agent_image_present_in_k3s; then
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
OPENSHELL_GW_LOCAL_PORT=30808

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
OPENSHELL_PORT_FORWARD_PID="${DATA_DIR}/.openshell-port-forward.pid"
if [[ -f "$OPENSHELL_PORT_FORWARD_PID" ]]; then
  _old_pid=$(cat "$OPENSHELL_PORT_FORWARD_PID" 2>/dev/null || true)
  if [[ "$_old_pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/${_old_pid}/cmdline" ]]; then
    _old_cmd=$(cat "/proc/${_old_pid}/cmdline" 2>/dev/null | tr '\0' ' ' || true)
    if kill -0 "$_old_pid" 2>/dev/null \
       && [[ "$_old_cmd" == *"kubectl port-forward"*"${OPENSHELL_GW_LOCAL_PORT}:8080"* ]]; then
      kill "$_old_pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$_old_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
  rm -f "$OPENSHELL_PORT_FORWARD_PID"
fi
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
      'openshell gateway remove "$OPENSHELL_GATEWAY_NAME" >/dev/null 2>&1 || true
       attempt=0
       until output=$(openshell gateway add "$OPENSHELL_GATEWAY_ENDPOINT" --local \
         --name "$OPENSHELL_GATEWAY_NAME" --oidc-issuer "$OPENSHELL_OIDC_ISSUER" \
         --oidc-client-id "$OPENSHELL_OIDC_CLIENT_ID" --oidc-audience "$OPENSHELL_OIDC_AUDIENCE" 2>&1); do
         attempt=$((attempt + 1)); if [ "$attempt" -ge 20 ]; then printf "%s\n" "$output" >&2; exit 1; fi; sleep 1
       done
       OPENSHELL_GATEWAY="$OPENSHELL_GATEWAY_NAME" openshell status'; then
  kill "$_port_forward_pid" 2>/dev/null || true
  rm -f "$OPENSHELL_PORT_FORWARD_PID"
  error "OpenShell gateway tunnel or mTLS authentication failed. See ${DATA_DIR}/openshell-port-forward.log"
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

DOCKER_RUN_ARGS=(
  -d
  --name ve-orchestrator
  --restart unless-stopped
  --network host
  "${OIDC_DOCKER_HOST_ARGS[@]}"
  --env-file "$ROOT_DIR/.env"
  -e DATABASE_PATH=/app/data/virtual-engineer.db
  -e GH_CONFIG_DIR=/ve-gh
  --security-opt label:disable
  -v /etc/localtime:/etc/localtime:ro
  -v "$DATA_DIR:/app/data:Z"
  -v "$HOME/.config/gh:/ve-gh:ro"
  --tmpfs /tmp/ve-review-diffs:rw,size=512m
  "${SSH_AGENT_ARGS[@]}"
  "${OPENSHELL_GATEWAY_ARGS[@]}"
)

LATEST_ID=$(docker inspect --format='{{.Id}}' virtual-engineer:latest 2>/dev/null || true)
RUNNING_ID=$(docker inspect --format='{{.Image}}' ve-orchestrator 2>/dev/null || true)
IS_RUNNING=$(docker inspect --format='{{.State.Running}}' ve-orchestrator 2>/dev/null || true)
OPENSHELL_OIDC_SECRET_HASH=$(printf '%s' "$OPENSHELL_OIDC_CLIENT_SECRET" | sha256sum | cut -d' ' -f1)
RUN_CONFIG_HASH=$(run_config_hash "$ROOT_DIR/.env" "${DOCKER_RUN_ARGS[@]}" \
  "oidc-secret-sha256=${OPENSHELL_OIDC_SECRET_HASH}")
RUN_CONFIG_MARKER="${DATA_DIR}/.orchestrator-run-config-hash"
STORED_RUN_CONFIG_HASH=$(cat "$RUN_CONFIG_MARKER" 2>/dev/null || true)

if should_reuse_container \
  "$IS_RUNNING" "$RUNNING_ID" "$LATEST_ID" "$STORED_RUN_CONFIG_HASH" "$RUN_CONFIG_HASH"; then
  info "ve-orchestrator is already running the latest image; gateway tunnel refreshed."
  info "Logs : docker logs -f ve-orchestrator"
  exit 0
fi

if [[ -n "$RUNNING_ID" ]]; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator
fi

info "Starting ve-orchestrator..."
docker run "${DOCKER_RUN_ARGS[@]}" virtual-engineer:latest
echo "$RUN_CONFIG_HASH" > "$RUN_CONFIG_MARKER"

info "ve-orchestrator started."

info "Admin UI : http://127.0.0.1:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"

