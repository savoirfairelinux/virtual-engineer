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
chart-generated client mTLS bundle into the named `virtual-engineer` profile,
authenticates that profile with Keycloak client credentials, and validates it
with `openshell status`; no OpenShell NodePort is exposed on the k3s node.
`16-network-policy-openshell.yaml`
restricts gateway ingress to the VE orchestrator and Pods in the dedicated
`ve-agents` sandbox namespace. The Agent Sandbox controller does not propagate
OpenShell labels to generated Pods, so the namespace is the enforceable trust
boundary.

Local reruns hash the contents of `.env` together with the exact effective
`docker run` arguments and volume/env options. Unchanged sources and runtime
configuration skip image rebuild/import and container recreation; changing
`.env` recreates only the orchestrator container unless build inputs also
changed. The decision still verifies the real Docker image and running
container state, so stale markers cannot suppress required work.

## 1. Build the orchestrator image with the OpenShell CLI

```bash
docker build -f Dockerfile.orchestrator \
  --build-arg INSTALL_OPENSHELL=true \
  --build-arg OPENSHELL_VERSION=v0.0.83 \
  -t virtual-engineer-orchestrator:latest .
```

Build the agent image too, push both to private GHCR, and resolve their immutable
multi-architecture digests. Production deployment rejects tags and accepts only
`ghcr.io/...@sha256:<64 lowercase hex>` references.

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

## 3. Configure Keycloak

OpenShell uses an externally managed Keycloak realm. Create:

- audience/resource server `openshell-cli`;
- confidential service-account client `openshell-ci`;
- realm roles `openshell-admin` and `openshell-user`, both assigned to that
  service account;
- a mapper that emits the roles at `realm_access.roles`.

Set `OPENSHELL_OIDC_ISSUER` to the exact realm issuer. Put the confidential
client secret in `virtual-engineer-secret` as
`OPENSHELL_OIDC_CLIENT_SECRET`; never put it in Helm values or a ConfigMap.

This section applies to the production `deploy.sh` path. Local single-node
startup through `scripts/start.sh` deploys the authenticated development
Keycloak manifest in `17-keycloak-local.yaml` automatically when issuer and
client secret are both absent. Generated local credentials remain under
`data/local-oidc/` with mode `0600`. Setting both variables switches local
startup to the external provider; setting only one is rejected.

## 4. Deploy OpenShell and Virtual Engineer

Create `virtual-engineer-secret` from the example, replacing both placeholders.
Prepare a Docker config JSON that can pull the private GHCR images, then run:

```bash
export OPENSHELL_OIDC_ISSUER=https://keycloak.example.com/realms/openshell
export VE_ORCHESTRATOR_IMAGE=ghcr.io/acme/virtual-engineer@sha256:<digest>
export VE_AGENT_IMAGE=ghcr.io/acme/virtual-engineer-workspace@sha256:<digest>
export DOCKER_CONFIG_JSON_FILE="$HOME/.docker/config.json"

kubectl apply -f deploy/k8s/20-orchestrator-secret.yaml
./deploy/k8s/deploy.sh
```

The script installs the chart by immutable OCI digest, pins the OpenShell 0.0.83
gateway and supervisor images by digest, creates `ve-ghcr-pull` in both
`virtual-engineer` and `ve-agents`, mirrors the generated client TLS bundle into
`ve-agents`, and renders both orchestrator containers with the supplied private
digest. The chart's sandbox image is the supplied `VE_AGENT_IMAGE` digest.

The raw Helm equivalent for inspection is:

Create the namespaces, gateway ServiceAccount, least-privilege RBAC, and gateway
NetworkPolicy before Helm starts the gateway Pod:

```bash
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl apply -f deploy/k8s/15-rbac-openshell.yaml
kubectl apply -f deploy/k8s/16-network-policy-openshell.yaml
```

```bash
helm template openshell \
  oci://ghcr.io/nvidia/openshell/helm-chart@sha256:583bcd4eecf7a255c6201ba3b571b5207ee0f643630dfa4835e981e62c754cc7 \
  --namespace virtual-engineer --create-namespace \
  -f deploy/k8s/openshell-gateway-values.yaml \
  --set-string server.oidc.issuer="$OPENSHELL_OIDC_ISSUER"
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

## 5. Manual Secret Creation

```bash
# Create the application secret first (do not commit the filled-in copy):
cp deploy/k8s/20-orchestrator-secret.example.yaml /tmp/ve-secret.yaml
# Replace ADMIN_AUTH_SECRET and OPENSHELL_OIDC_CLIENT_SECRET independently.
kubectl apply -f /tmp/ve-secret.yaml
```

## 6. Access the admin UI

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
- OpenShell runtime network policies are deny-by-default and authored per
  project/agent in the UI. The Kubernetes `NetworkPolicy` shipped here is a
  separate L3/L4 backstop that restricts ingress to the gateway; it does not
  enforce per-sandbox egress rules.
- Gateway transport remains TLS with client certificates, while CLI/user
  authorization is strict Keycloak OIDC (`allowUnauthenticatedUsers: false`).
  The VE service account uses OAuth2 client credentials. The CLI stores the
  bearer token in the named profile, renews it on an authentication failure,
  and replays the failed command once. Sandbox supervisors use gateway-minted
  JWTs instead of the VE OIDC identity. The NetworkPolicy admits only the
  orchestrator and Pods in the dedicated `ve-agents` namespace.
- The chart, OpenShell gateway/supervisor images, and both private VE images are
  digest-pinned. Registry credentials are namespace-scoped and mirrored to the
  gateway/orchestrator and sandbox namespaces.
- VE reads a bounded warning-level `openshell logs` snapshot after every
  post-creation attempt, scrubs secrets, and persists policy denials under the
  originating task and project.
