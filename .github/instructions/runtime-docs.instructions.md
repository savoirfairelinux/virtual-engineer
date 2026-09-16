---
applyTo: "src/index.ts,src/bootstrap/**,src/runtime/**,src/openshell/**"
description: "Keep bootstrap, runtime recovery, and OpenShell documentation in sync."
---
# Keep runtime and OpenShell docs in sync

When editing a matched file:

1. Update [.github/context/architecture.md](../context/architecture.md) when startup wiring, recovery, runtime dependency refresh, or lifecycle ownership changes.
2. Update the affected module reference instead of duplicating implementation detail: use [modules/orchestrator.md](../context/modules/orchestrator.md) for workflow/recovery, [modules/agents.md](../context/modules/agents.md) for agent execution, and [modules/workspace.md](../context/modules/workspace.md) for sandbox lifecycle and policy enforcement.
3. If an OpenShell policy, sandbox identity, egress rule, cleanup/reconciliation rule, or denial event contract changes, update the matching sections in `architecture.md`, `modules/agents.md`, and `modules/workspace.md`.
4. If a change alters a persisted table, column, index, or store contract, also update [database.md](../context/database.md) and follow the database instruction's migration rules.
5. Keep provider-specific facts in `modules/agents.md` or `modules/plugins.md`; keep this instruction focused on ownership and routing.
