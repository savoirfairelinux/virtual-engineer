---
applyTo: "src/workspace/**"
description: "Keep workspace/runtime documentation in sync with Docker and OpenShell runners."
---
# Keep workspace docs in sync

When editing files under `src/workspace/` (`hostGitExecutor.ts`, `openShellWorkspaceRunner.ts`, `agentWorkerProtocol.ts`, `skillSources.ts`, `skillSourceInstaller.ts`, `workspaceScanService.ts`):

1. If the workspace lifecycle changed (Docker volume execution or OpenShell upload/exec/download steps, prompt transport, egress application, cleanup order, denial collection), update:
   - the **Workspace** and **Sandbox hardening** sections in [.github/context/architecture.md](../context/architecture.md)
   - the **Architecture** bullet(s) in [.github/copilot-instructions.md](../copilot-instructions.md)
2. If host-side Git plumbing changed (clone/checkout/cherry-pick/push, trusted-metadata rebuild, trusted-repo gating), update [.github/context/modules/vcs.md](../context/modules/vcs.md) and [.github/context/modules/workspace.md](../context/modules/workspace.md).
3. Document `WORKSPACE_RUNTIME=legacy` as the default. The legacy path uses `DockerWorkspaceRunner`, `dockerVolume.ts`, `execInVolume`, and `ve-ws-*` / `ve-home-*` volumes; the opt-in OpenShell path uses runtime policies and gateway sandboxes. Keep the two lifecycles distinct.
4. Legacy paths are `/workspace` and `/ve-home`; OpenShell paths are `/sandbox/<basename(workspace dir)>`, `/tmp/user-prompt.txt`, and `/app/agent-worker/`. Do not describe one runtime's paths as the other's.
5. External skill sources (`skillSources.ts`, `skillSourceInstaller.ts`, `projects.skill_sources_json`) are parsed and forwarded onto `AgentSession.skillSourcesJson` / `ReviewWorkspaceInput.skillSourcesJson`, then fetched and installed **host-side** by `installSkillSources()` in `openShellWorkspaceRunner.ts`, after checkout and before workspace upload — so SSH material never enters the sandbox. If you change the install step (scope, supported providers, `.git/info/exclude` handling, timeout), keep `modules/workspace.md`, `modules/agents.md`, `context/architecture.md`, `context/database.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, and `copilot-instructions.md` in sync.
