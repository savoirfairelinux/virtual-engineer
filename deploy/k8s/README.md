# Virtual Engineer — Kubernetes deployment

Scalable deployment where **Virtual Engineer** is the business orchestrator and
**OpenShell** is the sandboxed agent runtime. Git plumbing and push stay in the
orchestrator pod (`HostGitExecutor`) so **push credentials never enter the agent
sandbox**; OpenShell schedules agent sandboxes as Kubernetes Pods via an
upload → exec → download lifecycle.

> OpenShell + Kubernetes is the **sole** agent runtime (Docker agent execution has
> been removed). For local single-node development use `scripts/start.sh`
> against k3s; the manifests here are the multi-node/cluster deployment path. See
> [`docs/adr/0001-openshell-agent-runtime.md`](../../docs/adr/0001-openshell-agent-runtime.md)
> for the decision record. Least-privilege sandbox RBAC lives in
> [`15-rbac-openshell.yaml`](15-rbac-openshell.yaml).

## Components

| Piece | What it is |
| --- | --- |
| `virtual-engineer-orchestrator` Deployment | VE control plane + admin UI (single replica; owns admission + SQLite state). |
| `virtual-engineer-data` PVC | SQLite WAL state store. |
| `openshell-gateway` (Helm) | OpenShell control plane using the Kubernetes driver; schedules sandbox Pods over TLS. |

The gateway Service is `ClusterIP` only. The local `scripts/start.sh` path
creates a managed `kubectl port-forward` bound to `127.0.0.1`, exports the
chart-generated client mTLS bundle into OpenShell's endpoint-derived profile
directory with mode `0600`, and validates it with `openshell status`; no
OpenShell NodePort is exposed on the k3s node. `16-network-policy-openshell.yaml`
restricts gateway ingress to the VE orchestrator and Pods in the dedicated
`ve-agents` sandbox namespace. The Agent Sandbox controller does not propagate
OpenShell labels to generated Pods, so the namespace is the enforceable trust
boundary.

## 1. Build the orchestrator image with the OpenShell CLI

```bash
docker build -f Dockerfile.orchestrator \
  --build-arg INSTALL_OPENSHELL=true \
  --build-arg OPENSHELL_VERSION=v0.0.79 \
  -t virtual-engineer-orchestrator:latest .
```

Push it to a registry your cluster can pull, and pin by digest in the Deployment.

## 2. Install the Agent Sandbox CRDs + controller (prerequisite)

The OpenShell Kubernetes driver reconciles `sandboxes.agents.x-k8s.io` custom
resources defined by the upstream
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
project. Install them **before** the gateway, or sandbox creation fails with
`no supported Agent Sandbox API version is available`:

```bash
AGENT_SANDBOX_VERSION=v0.5.1
AGENT_SANDBOX_MANIFEST_SHA256=8cfdf0a878f66b91d2e7103e77859d1412d850ce3f5fe5c3fa134c36bd55504a
curl -fsSL -o /tmp/agent-sandbox-manifest.yaml \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
echo "${AGENT_SANDBOX_MANIFEST_SHA256}  /tmp/agent-sandbox-manifest.yaml" | sha256sum --check
kubectl apply -f /tmp/agent-sandbox-manifest.yaml
kubectl wait --for=condition=available deployment/agent-sandbox-controller \
  -n agent-sandbox-system --timeout=120s
```

## 3. Install the OpenShell gateway

Create the namespaces, gateway ServiceAccount, least-privilege RBAC, and gateway
NetworkPolicy before Helm starts the gateway Pod:

```bash
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl apply -f deploy/k8s/15-rbac-openshell.yaml
kubectl apply -f deploy/k8s/16-network-policy-openshell.yaml
```

```bash
helm install openshell oci://ghcr.io/nvidia/openshell/helm-chart \
  --version 0.0.79 \
  --namespace virtual-engineer --create-namespace \
  -f deploy/k8s/openshell-gateway-values.yaml
```

The Kubernetes driver mounts the generated client bundle into sandbox
supervisors. Because Secrets are namespace-scoped, mirror it after each Helm
install or certificate rotation:

```bash
tmp_dir=$(mktemp -d)
for key in ca.crt tls.crt tls.key; do
  kubectl get secret openshell-client-tls -n virtual-engineer \
    -o "jsonpath={.data.${key//./\\.}}" | base64 --decode > "$tmp_dir/$key"
done
kubectl create secret generic openshell-client-tls -n ve-agents \
  --type=kubernetes.io/tls \
  --from-file="$tmp_dir/ca.crt" \
  --from-file="$tmp_dir/tls.crt" \
  --from-file="$tmp_dir/tls.key" \
  --dry-run=client -o yaml | kubectl apply -f -
rm -rf "$tmp_dir"
```

## 4. Deploy Virtual Engineer

```bash
# Create the admin secret first (do not commit the filled-in copy):
cp deploy/k8s/20-orchestrator-secret.example.yaml /tmp/ve-secret.yaml
sed -i "s/REPLACE_ME/$(openssl rand -hex 32)/" /tmp/ve-secret.yaml
kubectl apply -f /tmp/ve-secret.yaml

kubectl apply -f deploy/k8s/10-orchestrator-configmap.yaml
kubectl apply -f deploy/k8s/30-orchestrator-pvc.yaml
kubectl apply -f deploy/k8s/40-orchestrator-deployment.yaml
kubectl apply -f deploy/k8s/50-orchestrator-service.yaml
```

## 5. Access the admin UI

```bash
kubectl -n virtual-engineer port-forward svc/virtual-engineer-admin 3100:3100
# open http://127.0.0.1:3100 — Config → Policies to author sandbox policies,
# Config → Policy Denials to audit.
```

## Scheduling model

VE keeps **business admission** (`ConcurrencyTracker`, per-integration limits).
Kubernetes only **bin-packs** the OpenShell sandbox Pods. Do not double-schedule:
set per-sandbox CPU/RAM quotas in the gateway values, not VE-side pod limits.

## Security notes

- No Docker socket is mounted into any pod (the gateway uses the Kubernetes driver).
- The orchestrator runs non-root, read-only rootfs, all caps dropped; only the
  PVC, `/workspaces` (git), and `/tmp` are writable.
- Agent sandboxes get only agent-facing provider credentials (inference keys);
  push/review-system credentials stay in the orchestrator.
- Network policies are deny-by-default and authored per project/agent in the UI.
- Gateway transport is TLS with client certificates. Sandbox supervisors use
  gateway-minted JWTs for identity. OpenShell 0.0.79 does not expose a
  non-interactive CLI service identity, so CLI authorization remains constrained
  by ClusterIP, NetworkPolicy, and loopback-only port-forward. The NetworkPolicy
  admits only the orchestrator and Pods in the dedicated `ve-agents` namespace.
  Enabling its
  `mtls_auth` user mode on Kubernetes is unsafe because the chart intentionally
  mounts the same client TLS secret into sandbox supervisors.
- VE reads a bounded warning-level `openshell logs` snapshot after every
  post-creation attempt, scrubs secrets, and persists policy denials under the
  originating task and project.
