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
#   ./scripts/start.sh --openshell-version v0.0.79   # pin the OpenShell CLI version
#
# Optional environment variables:
#   DATA_DIR       (default: ./data)
#   K3S_KUBECONFIG (default: /etc/rancher/k3s/k3s.yaml)  k3s admin kubeconfig path
#   OPENSHELL_VERSION  (default: v0.0.79)  OpenShell CLI version baked into the orchestrator
#   K3S_VERSION (default: v1.32.3+k3s1) pinned k3s release
#   AGENT_SANDBOX_VERSION (default: v0.5.1) pinned controller manifest version
#   AGENT_SANDBOX_MANIFEST_SHA256 verified manifest digest for that version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

cd "$ROOT_DIR"

# ─── Parse arguments ──────────────────────────────────────────────────────────
K3S_INSTALL=true
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.79}"
OPENSHELL_INSTALLER_SHA256="${OPENSHELL_INSTALLER_SHA256:-c15d6cb8090e1c7c8d79a320b5bcbdaf1c15c2363942d81e84b56e03b836249e}"
OPENSHELL_CHART_VERSION="${OPENSHELL_CHART_VERSION:-0.0.79}"
K3S_VERSION="${K3S_VERSION:-v1.32.3+k3s1}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.5.1}"
AGENT_SANDBOX_MANIFEST_SHA256="${AGENT_SANDBOX_MANIFEST_SHA256:-8cfdf0a878f66b91d2e7103e77859d1412d850ce3f5fe5c3fa134c36bd55504a}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-k3s-install)
      K3S_INSTALL=false; shift ;;
    --openshell-version)
      [[ -n "${2:-}" ]] || error "--openshell-version requires a value (e.g. v0.0.79)"
      OPENSHELL_VERSION="$2"; shift 2 ;;
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

# ─── Preflight: k3s setup needs root, so sudo must be able to escalate ────────
# When 'no_new_privileges' is set on the current shell (e.g. some sandboxed
# terminals or hardened environments), it is inherited and sticky, so sudo
# (a setuid binary) can never gain root from here — no sudoers/NOPASSWD tweak
# helps. Detect it up front and fail fast instead of dying mid-install.
if [[ "$(id -u)" -ne 0 && "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status 2>/dev/null)" == "1" ]]; then
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
  if command -v k3s >/dev/null 2>&1 && sudo k3s kubectl get nodes >/dev/null 2>&1; then
    info "k3s already installed and running."
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
  INSTALL_K3S_VERSION="$K3S_VERSION" sh "$K3S_INSTALLER" \
    || error "k3s installation failed."
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
USER_KUBECONFIG="${DATA_DIR}/kubeconfig"
if sudo cp "$K3S_KUBECONFIG" "$USER_KUBECONFIG" 2>/dev/null; then
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
  || warn "Could not apply deploy/k8s/15-rbac-openshell.yaml — continuing."
KUBECONFIG="$K3S_KUBECONFIG" kubectl apply -f "$ROOT_DIR/deploy/k8s/16-network-policy-openshell.yaml" >/dev/null 2>&1 \
  || sudo k3s kubectl apply -f "$ROOT_DIR/deploy/k8s/16-network-policy-openshell.yaml" >/dev/null 2>&1 \
  || error "Could not apply the OpenShell gateway NetworkPolicy."

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
AGENT_HASH=$(build_inputs_hash Dockerfile.agent agent-worker)
AGENT_MARKER="${DATA_DIR}/.agent-image-hash"
if [[ "$(cat "$AGENT_MARKER" 2>/dev/null || true)" == "$AGENT_HASH" ]] \
   && docker image inspect virtual-engineer-workspace:latest >/dev/null 2>&1 \
   && sudo k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -q 'virtual-engineer-workspace:latest'; then
  info "Agent image up to date (sources unchanged, present in k3s) — skipping build + import."
else
  info "Building agent image..."
  docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
  info "Importing agent image into k3s containerd (k8s.io namespace)..."
  if docker save virtual-engineer-workspace:latest | sudo k3s ctr -n k8s.io images import - >/dev/null; then
    echo "$AGENT_HASH" > "$AGENT_MARKER"
  else
    warn "Could not import agent image into k3s — sandbox Pods may fail to start."
  fi
fi

# ─── Orchestrator image (always includes the OpenShell CLI) ───────────────────
# Skip the build when its inputs (Dockerfile + src + agent-worker + prompts +
# package/tsconfig/vite files + the pinned OpenShell version) are unchanged and
# the image already exists. The build's own layer cache is a fallback, but
# skipping the invocation avoids buildkit's metadata/context overhead.
ORCH_HASH=$(printf '%s\n%s\n' "$OPENSHELL_VERSION" \
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
if KUBECONFIG="$K3S_KUBECONFIG" kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
   && KUBECONFIG="$K3S_KUBECONFIG" kubectl get deployment agent-sandbox-controller -n agent-sandbox-system >/dev/null 2>&1; then
  info "Agent Sandbox CRDs + controller already installed — skipping."
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
    || warn "Could not apply Agent Sandbox manifest — sandbox creation will fail."
  rm -f "$AGENT_SANDBOX_MANIFEST_FILE"
  trap - EXIT
  KUBECONFIG="$K3S_KUBECONFIG" kubectl wait \
    --for=condition=available deployment/agent-sandbox-controller \
    -n agent-sandbox-system --timeout=120s >/dev/null 2>&1 \
    || warn "Agent Sandbox controller not ready — sandbox creation may fail."
fi

# ─── OpenShell gateway (Helm) ────────────────────────────────────────────────
# Skip the Helm upgrade + readiness wait when the release is already deployed
# with the current values file AND its pod is Ready (verifies real state, so a
# stale marker never causes an incorrect skip).
OPENSHELL_VALUES_FILE="$ROOT_DIR/deploy/k8s/openshell-gateway-values.yaml"
OPENSHELL_VALUES_HASH=$(printf '%s\n%s\n' "$OPENSHELL_CHART_VERSION" \
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
    oci://ghcr.io/nvidia/openshell/helm-chart \
    --version "$OPENSHELL_CHART_VERSION" \
    --namespace virtual-engineer --create-namespace \
    --wait --timeout 180s \
    -f "$OPENSHELL_VALUES_FILE" \
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
  _old_cmd=$(tr '\0' ' ' < "/proc/${_old_pid}/cmdline" 2>/dev/null || true)
  if [[ "$_old_pid" =~ ^[0-9]+$ ]] && kill -0 "$_old_pid" 2>/dev/null \
     && [[ "$_old_cmd" == *"kubectl port-forward"*"${OPENSHELL_GW_LOCAL_PORT}:8080"* ]]; then
    kill "$_old_pid" 2>/dev/null || true
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

if ! curl --fail-with-body --silent --show-error --output /dev/null \
    --retry 20 --retry-delay 1 --retry-connrefused --connect-timeout 1 \
  "http://127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}/healthz"; then
  kill "$_port_forward_pid" 2>/dev/null || true
  rm -f "$OPENSHELL_PORT_FORWARD_PID"
  error "OpenShell gateway tunnel did not become reachable. See ${DATA_DIR}/openshell-port-forward.log"
fi

OPENSHELL_GATEWAY_ARGS="-e OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:${OPENSHELL_GW_LOCAL_PORT}"

# ─── Idempotent container restart ─────────────────────────────────────────────
# The tunnel is reconciled first so rerunning this script repairs a dead
# gateway connection even when the current orchestrator image is still running.
LATEST_ID=$(docker inspect --format='{{.Id}}' virtual-engineer:latest 2>/dev/null || true)
RUNNING_ID=$(docker inspect --format='{{.Image}}' ve-orchestrator 2>/dev/null || true)
IS_RUNNING=$(docker inspect --format='{{.State.Running}}' ve-orchestrator 2>/dev/null || true)

if [[ "$IS_RUNNING" == "true" && "$RUNNING_ID" == "$LATEST_ID" ]]; then
  info "ve-orchestrator is already running the latest image; gateway tunnel refreshed."
  info "Logs : docker logs -f ve-orchestrator"
  exit 0
fi

if [[ -n "$RUNNING_ID" ]]; then
  info "Removing existing ve-orchestrator container..."
  docker rm -f ve-orchestrator
fi

info "Starting ve-orchestrator..."

SSH_AGENT_ARGS=""
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
  info "SSH agent detected at $SSH_AUTH_SOCK — forwarding into container."
  SSH_AGENT_ARGS="-v $SSH_AUTH_SOCK:$SSH_AUTH_SOCK -e SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
else
  warn "No SSH agent socket found (SSH_AUTH_SOCK not set or not a socket). Agent-based SSH auth will not be available."
fi

# shellcheck disable=SC2086 — intentional word-splitting for SSH_AGENT_ARGS / OPENSHELL_GATEWAY_ARGS
docker run -d \
  --name ve-orchestrator \
  --restart unless-stopped \
  --network host \
  --env-file "$ROOT_DIR/.env" \
  -e DATABASE_PATH=/app/data/virtual-engineer.db \
  -e GH_CONFIG_DIR=/ve-gh \
  --security-opt label:disable \
  -v /etc/localtime:/etc/localtime:ro \
  -v "$DATA_DIR:/app/data:Z" \
  -v "$HOME/.config/gh:/ve-gh:ro" \
  --tmpfs /tmp/ve-review-diffs:rw,size=512m \
  $SSH_AGENT_ARGS \
  $OPENSHELL_GATEWAY_ARGS \
  virtual-engineer:latest

info "ve-orchestrator started."

info "Admin UI : http://127.0.0.1:3100/admin (binds per ADMIN_API_HOST in .env)"
info "Logs     : docker logs -f ve-orchestrator"

