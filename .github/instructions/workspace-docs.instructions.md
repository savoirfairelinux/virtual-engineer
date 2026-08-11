---
applyTo: "src/workspace/**"
description: "Keep workspace/runtime documentation in sync with the OpenShell sandbox runner."
---
# Keep workspace docs in sync

When editing files under `src/workspace/` (`hostGitExecutor.ts`, `openShellWorkspaceRunner.ts`, `agentWorkerProtocol.ts`, `skillSources.ts`, `workspaceScanService.ts`):

1. If the sandbox lifecycle changed (upload/exec/download steps, prompt transport, egress application, cleanup order, denial collection), update:
   - the **Workspace** and **Sandbox hardening** sections in [.github/context/architecture.md](../context/architecture.md)
   - the **Architecture** bullet(s) in [.github/copilot-instructions.md](../copilot-instructions.md)
2. If host-side Git plumbing changed (clone/checkout/cherry-pick/push, trusted-metadata rebuild, trusted-repo gating), update [.github/context/modules/vcs.md](../context/modules/vcs.md) and [.github/context/modules/workspace.md](../context/modules/workspace.md).
3. Describe the runtime as an **OpenShell sandbox**, not a Docker container with named volumes. There is no `DockerWorkspaceRunner`, no `dockerVolume.ts`, no `execInVolume`, and no `ve-ws-*` / `ve-home-*` volumes. Isolation comes from OpenShell runtime **policies** (deny-by-default filesystem/network/process), not Docker flags. Docker appears only as the gateway's default *compute driver*; Kubernetes is the experimental alternative.
4. Sandbox paths: the host workspace is uploaded to `/sandbox/<basename(workspace dir)>` (that path is also the exec `workdir`), the worker runtime lives at `/app/agent-worker/`, and only `/sandbox`, `/tmp` and `/dev/null` are writable under the default policy. Do not document `/workspace` or `/ve-home`.
5. External skill sources (`skillSources.ts`, `projects.skill_sources_json`) are parsed and forwarded onto `AgentSession.skillSourcesJson` but **never installed** — the `npx skills` install step was removed with the Docker runner. If you add an OpenShell install path, drop the regression notes in `modules/workspace.md`, `modules/agents.md`, `context/architecture.md`, `context/database.md`, and `copilot-instructions.md`; until then keep documenting them as inert.
