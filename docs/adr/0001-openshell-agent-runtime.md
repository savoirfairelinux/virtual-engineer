# ADR: Integrating OpenShell as Virtual Engineer Agent Runtime

- **ADR number:** 0001
- **Date:** 2026-07-09
- **Deciders:** VE architecture / platform team
- **Technical area:** `src/workspace/**`, `src/agents/**`, agent runtime & sandboxing

## Status

**Accepted (implemented) — experimental & opt-in. Docker remains the seeded default.**

The pluggable runtime is built and merged: a `RuntimeRegistry` selects a
`WorkspaceRunner` per project/agent (`docker` | `openshell`), the OpenShell
backend (client, deny-by-default policy builder, deny-event poller, host-side git
executor) is implemented and tested, admin API + dashboard expose runtime
selection / policy CRUD / denial audit, and Kubernetes manifests + an opt-in
pinned OpenShell CLI are provided.

The **boot/seed default stays `docker`** — flipping it to `openshell` is a single
setting (`app_settings.default_runtime`, editable from the admin Runtime tab) and
is deliberately **not** hard-coded until the [Acceptance Criteria](#acceptance-criteria-before-openshell-becomes-default)
are satisfied against a live gateway. This preserves a working default and honours
the "keep Docker until validated" invariant while making OpenShell available for
opt-in evaluation per project/agent.

Rationale for not making OpenShell the seeded default now:

- OpenShell self-describes as **alpha, "single-player mode" (v0.0.x)**; multi-tenant
  is a roadmap item. Its **Kubernetes path is upstream "experimental."**
- The acceptance criteria (live review + coding E2E, benchmark vs Docker, K8s
  validation) require a running gateway not present in the default dev/test setup.
- Docker remains a first-class, fully-tested runtime plugin (the permanent kill-switch).


## Context

- Virtual Engineer currently executes agents in **ephemeral Docker containers** driven by
  `DockerWorkspaceRunner` (`src/workspace/workspaceRunner.ts`), backed by Docker **named
  volumes** (`src/workspace/dockerVolume.ts`). VCS operations (clone, patchset checkout,
  cherry-pick, push) run in **helper containers** that mount the workspace volume; the
  **host owns review-system credentials and push orchestration** through `src/vcs/`.
- Container hardening today: `--read-only`, `--cap-drop ALL`,
  `--security-opt no-new-privileges:true`, `--tmpfs /tmp`, a `/workspace` + `/ve-home`
  named-volume pair, and a dedicated Docker network (`virtual-engineer_ve-agent-net`).
  The in-container worker (`agent-worker/src/index.ts`) filters host env to a minimal
  allowlist and enforces an outbound `networkGuard`.
- A `WorkspaceRunner` interface **already exists** in `src/interfaces.ts`; the orchestrator,
  polling loop, review orchestrator, and `configureAgentAdapter` all depend on that
  interface, not on Docker directly.
- Goals driving this evaluation: stronger **L7 network policy** (method/path deny-by-default),
  cleaner **credential isolation**, **auditable** per-project/per-agent policies, easier
  **multi-agent** support (Claude Code, Codex, OpenCode, Copilot CLI, OpenClaw…), and real
  **scalability** toward Kubernetes.
- OpenShell (NVIDIA) offers exactly this problem framing: a **gateway control plane**, a
  **policy engine** across four domains (filesystem / network / process / inference),
  declarative **YAML policies** (network + inference hot-reloadable), a **credential
  provider** model that injects secrets as env vars (never on disk), an **inference
  privacy router** (`inference.local`), and pluggable compute drivers (Docker / Podman /
  MicroVM / Kubernetes).

VE must keep its business value: Git-provider integrations (GitHub / GitLab / Gerrit /
Redmine), issue/PR/MR parsing, task state machine, agent-cycle orchestration, result
validation, and **host-side commit/push/review-comment posting**. OpenShell must not be
allowed to absorb that logic.

## Decision

1. **Do not replace `DockerWorkspaceRunner`.** Keep it as the default and only
   production-supported runtime.
2. **Add `OpenShellWorkspaceRunner` as an experimental, feature-flagged alternative**
   implementing the existing `WorkspaceRunner` interface.
3. **Keep Docker as the permanent fallback** (not a temporary one) until every acceptance
   criterion below is satisfied.
4. **Scope the spike to the review agent first** (shorter-lived, read-mostly, no push →
   lowest blast radius), then coding agents.
5. **Target Docker/Podman drivers locally first.** Treat Kubernetes as a *later* milestone,
   gated on OpenShell's own Kubernetes path leaving "experimental."
6. **Never give push credentials to the agent/sandbox.** Commit and push stay host-side
   in `src/vcs/`, exactly as today. OpenShell manages only the credentials the *agent*
   legitimately needs (inference API keys, scoped read tokens).

## Decision Drivers

- Network deny-by-default (VE already has L3/L4 deny-by-default; OpenShell adds L7).
- Credential isolation (env-injection, no on-disk secrets).
- Policy auditability (declarative YAML, visible per project/agent).
- Multi-agent support (Claude, Codex, OpenCode, Copilot, OpenClaw…).
- Compatibility with VE's existing `WorkspaceRunner` contract and host-side git plumbing.
- **Maturity / stability of OpenShell (currently the dominant negative driver).**
- Maintainability and operational complexity (adding a Rust gateway control plane).
- Kubernetes scalability as a *production* objective.

## Considered Options

### Option 1 — Keep the current Docker runner only

- **Pros:** zero new dependency; already hardened; fully owned; passes all VE gates today;
  no new operational surface.
- **Cons:** network policy stays L3/L4 (no HTTP method/path control); no built-in inference
  privacy router; scaling is manual (per-host Docker); policies are code, not declarative
  auditable artifacts.
- **Risks:** low. Status quo.

### Option 2 — Add OpenShell as an optional, feature-flagged runtime (recommended)

- **Pros:** preserves Docker default; lets VE evaluate L7 policy, inference routing, and
  MicroVM isolation on real workloads; reversible via flag; no destructive DB change; the
  `WorkspaceRunner` seam already exists.
- **Cons:** two runtimes to test and maintain; OpenShell is alpha; gateway is another
  moving part; some VE operations (multi-target clone, cherry-pick, host push) don't map to
  OpenShell primitives and must stay host-side.
- **Risks:** medium — alpha API churn, partial semantic mismatch, extra CI matrix.

### Option 3 — Replace Docker with OpenShell directly

- **Pros:** single runtime long-term; full policy engine; single credential model.
- **Cons:** hard dependency on **alpha, single-player** software for a core execution path;
  breaking-change exposure at v0.0.x; loss of a working, hardened path; multi-tenant not
  yet available while VE runs many concurrent tasks/projects.
- **Risks:** **high / unacceptable now.** This is the option to reject.

### Option 4 — Use OpenShell only for specific agents/projects

- **Pros:** blast-radius control; lets high-value or high-risk projects opt in; natural
  A/B of runtimes; aligns with VE's per-project settings model.
- **Cons:** heterogeneous fleet; more matrix testing; behaviour differences per project.
- **Risks:** medium — but this is effectively Option 2 with a per-project selector, and is
  the intended *rollout shape* of Option 2.

## Recommended Option

**Option 2, rolled out in the shape of Option 4** — add `OpenShellWorkspaceRunner` behind a
runtime feature flag, selectable **per project/agent**, starting with review agents, with
Docker remaining the default. This is superior because:

- It exploits the seam VE already has (`WorkspaceRunner`), so integration cost is bounded.
- It contains alpha risk to opt-in projects and the lowest-risk agent type (review).
- It never sacrifices the working Docker path, satisfying the "keep business value + keep
  push host-side + deny-by-default" constraints.
- It defers the genuinely immature parts (Kubernetes, multi-tenant, GPU) until upstream and
  VE evidence justify them.

Rejecting Option 3 explicitly: **do not** make OpenShell the sole runtime while it is
self-described as alpha/single-player.

## Consequences

### Positive Consequences

- L7 (HTTP method/path) egress control on top of VE's existing L3/L4 deny-by-default.
- Declarative, auditable, per-project/agent policies surfaced in VE's admin UI.
- Cleaner inference-credential isolation and optional `inference.local` privacy routing.
- A cleaner, provider-agnostic multi-agent launch path (Claude/Codex/OpenCode/Copilot).
- A future, upstream-maintained road to MicroVM and Kubernetes execution.

### Negative Consequences

- New dependency on **alpha** software with frequent breaking releases (70 releases,
  currently v0.0.x).
- A second runtime to test → CI matrix and maintenance cost roughly doubles for the
  execution layer.
- New operational surface: a gateway control plane (Rust) to deploy, monitor, and secure.
- Harder debugging (agent failures now cross a policy engine + gateway boundary).
- Must maintain the Docker fallback indefinitely until criteria are met.
- Semantic mismatch: VE's multi-target clone/cherry-pick/host-push do **not** map to
  OpenShell sandbox primitives and stay host-side, so OpenShell only owns *agent execution*,
  not the git plumbing — the abstraction must make that boundary explicit.

## Migration Plan

1. Formalise/verify the existing `WorkspaceRunner` seam (already present) and add a runtime
   selector (`RuntimeProfile`).
2. Keep `DockerWorkspaceRunner` as the default implementation (already encapsulated).
3. Add a minimal `OpenShellWorkspaceRunner` (`createWorkspace` → `sandbox create`;
   `runReviewInDocker`/`runAgent` → sandbox exec; `destroyWorkspace` → `sandbox rm`).
   Clone/patchset/cherry-pick/push remain host-side or via the existing helper-container
   path bound into the sandbox workspace.
4. Add `OpenShellPolicyBuilder` that emits YAML policy from VE project/agent config.
5. Add `AgentProfile` / `AgentRegistry` so agent choice maps to a runtime profile + policy.
6. Surface OpenShell **policy-denial events** in VE's API/UI (poll `openshell logs` / policy
   decision stream → persist → dashboard).
7. Validate end-to-end on the **review agent** behind the flag.
8. Validate end-to-end on the **coding agent** (including host-side push staying host-side).
9. Add a Kubernetes/gateway mode — only after upstream K8s leaves "experimental."
10. Re-evaluate making OpenShell default; ADR revised to *Accepted* only if criteria pass.

## Rollback Plan

- **Feature flag runtime**: `RUNTIME=docker|openshell` per project/agent; default `docker`.
- **Docker fallback**: never removed; `OpenShellWorkspaceRunner` failures fall back or fail
  the task without affecting Docker-runtime projects.
- **Per-project disable**: flip the project runtime back to `docker`; no redeploy of tasks.
- **No destructive DB change**: runtime selection stored as nullable columns/settings
  (NULL = Docker default), so rollback is a config revert, not a migration.
- **Keep the old runner**: `DockerWorkspaceRunner` stays first-class and tested until the
  ADR is promoted to *Accepted*.

## Security Considerations

- **Code exfiltration:** OpenShell L7 egress deny-by-default + VE's existing `networkGuard`
  reduce exfil surface; policies must allowlist only required inference/registry endpoints.
- **Prompt injection:** unchanged threat; mitigated by deny-by-default network + no push
  credentials in-sandbox, so an injected agent cannot push or reach arbitrary hosts.
- **Secrets in environment:** OpenShell injects provider creds as env vars (not on disk);
  VE must still scope those to *agent-needed* creds only — **never** push/review-system
  credentials.
- **Outbound network:** must stay deny-by-default; every allow entry auditable per project.
- **Filesystem access:** locked at sandbox creation; restrict to `/workspace` equivalent.
- **Sensitive logs:** policy-denial and sandbox logs must be scrubbed of tokens before
  persistence/UI display.
- **Kubernetes permissions:** if/when K8s mode lands, the gateway's RBAC and the sandbox
  pods' service accounts must be least-privilege; no cluster-admin, no host mounts.
- **Docker socket exposure:** if OpenShell's Docker driver needs `/var/run/docker.sock`,
  treat it as a **container-escape-equivalent** risk — prefer Podman/rootless or MicroVM;
  never mount the socket into the *agent* sandbox, only the gateway if unavoidable.

## Scalability Considerations

- **Docker local:** single-host; equivalent to today plus gateway overhead. Not a scaling win.
- **Podman:** rootless improves host security; still single-host scaling.
- **MicroVM:** stronger isolation, higher per-sandbox cost/latency; good for untrusted code.
- **Kubernetes:** the only path to real horizontal scaling — but **experimental upstream**.
- **Gateway limits:** the gateway is a control-plane bottleneck/SPOF; HA is early-stage.
- **CPU/RAM quotas:** must be set per sandbox/agent to prevent noisy-neighbour effects.
- **Concurrency:** VE already gates concurrency per integration via `ConcurrencyTracker`;
  with K8s, decide explicitly whether VE or the K8s scheduler owns admission — **do not
  double-schedule**. Recommended: VE keeps business admission; K8s handles bin-packing.

## Open Questions

- Does OpenShell support **multiple `inference.local` routes** per project/agent/provider
  concurrently, or is inference routing gateway-global (single-player assumption)?
- Is the **Kubernetes mode** stable enough for VE's concurrency, or still pre-1.0 churn?
- What is the **stable API/CLI surface** VE should bind to (CLI vs gRPC/proto vs Python
  SDK), and what is its breaking-change cadence at v0.0.x?
- How are **policy-denial events** retrieved programmatically (structured stream vs log
  scraping) for VE persistence/UI?
- How to export **modified files / diffs** out of a sandbox cleanly for host-side commit?
- How to model **timeouts and cancellation** of a sandbox and map to VE task states?
- How do OpenShell failure modes map to VE states (`FAILED` / `ABANDONED` / `REVIEW_FAILED`)?
- How to **test policies automatically** (a policy unit-test / assertion harness)?

## Acceptance Criteria (before OpenShell becomes default)

- Review agent works end-to-end via `OpenShellWorkspaceRunner`.
- Coding agent works end-to-end, with commit/push still executed **host-side**.
- **No push/review-system credential is ever exposed to the agent/sandbox.**
- Network is **deny-by-default**; allowed endpoints configurable per project.
- Policy denials are **visible in VE** (API + dashboard) and scrubbed of secrets.
- **Docker fallback still works** and remains fully tested.
- Automated tests cover **both** Docker and OpenShell runners.
- A minimal **benchmark** shows acceptable startup/latency/throughput vs Docker.
- If scaling is a production goal, **Kubernetes mode is validated** (and upstream K8s is no
  longer "experimental").
- OpenShell has reached a **stable (≥1.0 or explicitly stability-committed) release** with a
  documented, versioned integration API.

## Final Recommendation

Adopt OpenShell as an **experimental, policy-based, feature-flagged agent runtime for
Virtual Engineer — initially for review agents on opt-in projects — while keeping Docker as
the default and permanently supported runtime until security, stability, observability, a
stable upstream API, and (if required) Kubernetes scalability criteria are all satisfied.**
