---
applyTo: "src/agents/**,agent-worker/**"
description: "Keep agent documentation in sync with adapters, the OpenShell sandbox spec, runtime policies, and the in-sandbox CLI server."
---
# Keep agent docs in sync

When editing files under `src/agents/` or `agent-worker/`:

1. If the sandbox spec changed, update both the **Copilot/Claude/Aider/Goose Execution** bullets in [.github/copilot-instructions.md](../copilot-instructions.md) and the **Sandbox Environment** / engine-specific sections in [.github/context/modules/agents.md](../context/modules/agents.md). Triggers:
   - `buildCodegenContainerSpec` / `buildReviewContainerSpec` in `src/agents/containerSpecBuilders.ts` (new/renamed env var, changed `command`, changed prompt transport such as `SYSTEM_PROMPT_BASE64` / `userPromptContent`)
   - an adapter's `AgentEgressSpec` (`COPILOT_EGRESS`, `CLAUDE_EGRESS`, `src/agents/backendEgress.ts`) gaining or losing hosts/binaries — sandbox egress is deny-by-default, so this is behaviour-visible
   - a new credential env var, which must also be added to `AGENT_CREDENTIAL_PROVIDER_TYPES` in `src/workspace/openShellWorkspaceRunner.ts` or the run fails closed
   - anything affecting the OpenShell runtime **policy** floor (`src/openshell/openShellPolicyBuilder.ts`, `runtimePolicyResolver.ts`) or the sandbox paths `/sandbox`, `/tmp`, `/app/agent-worker/`

   The spec is `{ image, env, command, userPromptContent?, egress? }`. Never document `networkMode`, `additionalDockerArgs`, Docker mounts, named volumes, `/workspace`, or `/ve-home` — none exist.
2. If a new adapter file was added (alternative LLM backend, e.g. `claudeAdapter.ts` or `aiderAdapter.ts`), add it to the agent inventory in `modules/agents.md`, the provider ids in `modules/plugins.md` / `modules/connectors.md`, and the source layout in `copilot-instructions.md`.
3. If the in-sandbox headless CLI boot, worker timeout, or review-mode (`REVIEW_MODE=1`) execution changed, update the **Copilot Execution** / **Claude Execution** / **Aider Execution** / **Goose Execution** sections in `copilot-instructions.md` and `modules/agents.md`.
4. If `AgentSession` or `TaskContext` (in `src/interfaces.ts`) gained/lost a field consumed by the agent, update the snippet in `modules/agents.md`.
5. Provider ids are `github | gitlab | gerrit | redmine | copilot | claude | aider | goose | mock`. When adding an `agent_execution` engine, cover both its coding and review flows.
6. Remote skill sources (`AgentSession.skillSourcesJson`) are fetched and installed **host-side** by `src/workspace/skillSourceInstaller.ts`, before the workspace is uploaded — the worker itself still performs no skill fetch or install. If you change what the worker receives (env vars, mounted paths), keep `modules/agents.md`, `modules/workspace.md`, and `context/architecture.md` in sync; do not reintroduce a worker-side install path without updating those docs.
