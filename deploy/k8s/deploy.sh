#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy-lib.sh"

error() { echo "[ERROR] $*" >&2; exit 1; }

VE_ORCHESTRATOR_IMAGE="${VE_ORCHESTRATOR_IMAGE:-}"
VE_AGENT_IMAGE="${VE_AGENT_IMAGE:-}"
DOCKER_CONFIG_JSON_FILE="${DOCKER_CONFIG_JSON_FILE:-}"
OPENSHELL_OIDC_ISSUER="${OPENSHELL_OIDC_ISSUER:-}"
OPENSHELL_OIDC_CLIENT_ID="${OPENSHELL_OIDC_CLIENT_ID:-openshell-ci}"
OPENSHELL_OIDC_AUDIENCE="${OPENSHELL_OIDC_AUDIENCE:-openshell-cli}"
OPENSHELL_OIDC_CA_CONFIG_MAP="${OPENSHELL_OIDC_CA_CONFIG_MAP:-}"
IMAGE_PULL_SECRET="ve-ghcr-pull"
OPENSHELL_CHART="oci://ghcr.io/nvidia/openshell/helm-chart@sha256:583bcd4eecf7a255c6201ba3b571b5207ee0f643630dfa4835e981e62c754cc7"
OPENSHELL_GATEWAY_IMAGE_TAG="0.0.83@sha256:80e898dc9ad46e4f40b8b0e8648658d0e51b83f1c2071cf4983ac6d52b9c95d6"
OPENSHELL_SUPERVISOR_IMAGE_TAG="0.0.83@sha256:9f5c14d914731f84ce38e61cba4cec425a59f0aad4be0c0906342c68ba65a86f"

require_ghcr_digest_ref "$VE_ORCHESTRATOR_IMAGE" \
  || error "VE_ORCHESTRATOR_IMAGE must be ghcr.io/...@sha256:<64 lowercase hex>."
require_ghcr_digest_ref "$VE_AGENT_IMAGE" \
  || error "VE_AGENT_IMAGE must be ghcr.io/...@sha256:<64 lowercase hex>."
[[ -f "$DOCKER_CONFIG_JSON_FILE" ]] \
  || error "DOCKER_CONFIG_JSON_FILE must reference a Docker config JSON file."
[[ -n "$OPENSHELL_OIDC_ISSUER" ]] || error "OPENSHELL_OIDC_ISSUER is required."

kubectl apply -f "$SCRIPT_DIR/00-namespace.yaml"
for namespace in virtual-engineer ve-agents; do
  kubectl create secret generic "$IMAGE_PULL_SECRET" \
    --namespace "$namespace" \
    --type=kubernetes.io/dockerconfigjson \
    --from-file=".dockerconfigjson=${DOCKER_CONFIG_JSON_FILE}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

kubectl apply -f "$SCRIPT_DIR/15-rbac-openshell.yaml"
kubectl delete rolebinding ve-openshell-gateway role ve-agent-pod-manager \
  --namespace ve-agents --ignore-not-found
kubectl apply -f "$SCRIPT_DIR/16-network-policy-openshell.yaml"

helm upgrade --install openshell "$OPENSHELL_CHART" \
  --namespace virtual-engineer --create-namespace \
  --wait --timeout 180s \
  -f "$SCRIPT_DIR/openshell-gateway-values.yaml" \
  --set-string "image.tag=${OPENSHELL_GATEWAY_IMAGE_TAG}" \
  --set-string "supervisor.image.tag=${OPENSHELL_SUPERVISOR_IMAGE_TAG}" \
  --set-string "imagePullSecrets[0].name=${IMAGE_PULL_SECRET}" \
  --set-string "server.sandboxImage=${VE_AGENT_IMAGE}" \
  --set-string "server.sandboxImagePullSecrets[0].name=${IMAGE_PULL_SECRET}" \
  --set-string "server.oidc.issuer=${OPENSHELL_OIDC_ISSUER}" \
  --set-string "server.oidc.audience=${OPENSHELL_OIDC_AUDIENCE}" \
  --set-string "server.oidc.caConfigMapName=${OPENSHELL_OIDC_CA_CONFIG_MAP}"

tls_dir=$(mktemp -d)
trap 'rm -rf "$tls_dir"' EXIT
for key in ca.crt tls.crt tls.key; do
  kubectl get secret openshell-client-tls -n virtual-engineer \
    -o "jsonpath={.data.${key//./\\.}}" | base64 --decode >"${tls_dir}/${key}"
done
kubectl create secret generic openshell-client-tls \
  --namespace ve-agents \
  --type=kubernetes.io/tls \
  --from-file="ca.crt=${tls_dir}/ca.crt" \
  --from-file="tls.crt=${tls_dir}/tls.crt" \
  --from-file="tls.key=${tls_dir}/tls.key" \
  --dry-run=client -o yaml | kubectl apply -f -
rm -rf "$tls_dir"
trap - EXIT

kubectl create configmap virtual-engineer-oidc \
  --namespace virtual-engineer \
  --from-literal="OPENSHELL_OIDC_ISSUER=${OPENSHELL_OIDC_ISSUER}" \
  --from-literal="OPENSHELL_OIDC_CLIENT_ID=${OPENSHELL_OIDC_CLIENT_ID}" \
  --from-literal="OPENSHELL_OIDC_AUDIENCE=${OPENSHELL_OIDC_AUDIENCE}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl get secret virtual-engineer-secret -n virtual-engineer \
  -o jsonpath='{.data.OPENSHELL_OIDC_CLIENT_SECRET}' | grep -q . \
  || error "virtual-engineer-secret must contain OPENSHELL_OIDC_CLIENT_SECRET."

kubectl apply -f "$SCRIPT_DIR/10-orchestrator-configmap.yaml"
kubectl apply -f "$SCRIPT_DIR/30-orchestrator-pvc.yaml"
kubectl apply -f "$SCRIPT_DIR/50-orchestrator-service.yaml"
kubectl set image --local -f "$SCRIPT_DIR/40-orchestrator-deployment.yaml" \
  "*=${VE_ORCHESTRATOR_IMAGE}" \
  -o yaml | kubectl apply -f -
kubectl rollout restart deployment/virtual-engineer-orchestrator -n virtual-engineer
kubectl rollout status deployment/virtual-engineer-orchestrator \
  -n virtual-engineer --timeout=180s