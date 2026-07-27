---
applyTo: "src/workspace/**"
description: "Keep workspace/runtime documentation in sync with the Docker named-volume runner."
---
# Keep workspace docs in sync

When editing files under `src/workspace/` (`dockerVolume.ts`, `workspaceRunner.ts`, `skillSources.ts`):

1. If the container/volume lifecycle changed (new named volume, mount, clone/helper-container step, cleanup order), update:
   - the **Workspace** and **Container hardening** sections in [.github/context/architecture.md](../context/architecture.md)
   - the **Architecture** bullet(s) in [.github/copilot-instructions.md](../copilot-instructions.md)
2. If remote/local skill installation changed (`npx skills` args, `/ve-home` handling, SSH source handling), update the **External Skills** section in [.github/context/modules/agents.md](../context/modules/agents.md).
3. Never describe the runtime as an OpenShell/Kubernetes sandbox — the runner is **Docker named volumes** on the host. Keep terminology as "container" / "named volume", not "sandbox".
