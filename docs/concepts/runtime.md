# Agent runtime

Why every agent runs in an OpenShell sandbox.

OpenShell is the only agent runtime. Earlier versions ran agents in hardened Docker containers started by the orchestrator. That runner, its named volumes, and per-project runtime selection were removed rather than kept as a fallback, so there is one execution path to secure and test.

## Why OpenShell

- **Egress is denied by default per run.** Container flags could only isolate a network. A runtime policy opens exactly the hosts and binaries an engine declares.
- **Policy is data, not code.** Isolation is a declarative document bound per project or per agent, and every denial is recorded.
- **The model credential is isolated.** It is attached as a short-lived provider instead of living in the container environment or on disk.
- **Every engine launches the same way.** Adding an engine means adding an adapter, not another container recipe.
- **The compute backend is swappable.** The gateway schedules sandboxes through a compute driver, so the same upload → exec → download lifecycle runs on Docker or Kubernetes.

## What OpenShell does not own

OpenShell owns agent execution and nothing else. Clone, checkout, cherry-pick, push, and review posting have no sandbox equivalent and stay in the orchestrator. That boundary is what keeps push and review credentials out of the sandbox — see [Trust boundaries](trust.md).

## Compute drivers

Docker is the default driver. Kubernetes is opt-in through `OPENSHELL_COMPUTE_DRIVER` and is experimental upstream, so validate it before relying on it in production. The runner does not change between drivers.

## Costs accepted

- The gateway is one more control plane to deploy, monitor, and secure, and every cycle passes through it.
- An agent failure now crosses a policy engine, so debugging starts from the harvested denials — see [Debug a task](../operations/debug.md).
- OpenShell is pre-1.0. The version is pinned and upgraded deliberately.

Related: [Sandbox](../hubs/sandbox.md), [Environment variables](../reference/ref-config.md).
