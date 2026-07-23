---
applyTo: "src/agents/**,agent-worker/**"
description: "Keep agent documentation in sync with adapters, container spec, and CLI server."
---
# Keep agent docs in sync

When editing files under `src/agents/` or `agent-worker/`:

1. If `buildContainerSpec` / `buildReviewContainerSpec` in `src/agents/copilotAdapter.ts` (or the equivalent in `src/agents/claudeAdapter.ts` or `src/agents/aiderAdapter.ts`) changed (new env var, new docker arg, new mount, networkMode change), update both:
   - the **Container constraints** bullet in [.github/copilot-instructions.md](../copilot-instructions.md)
   - the **Container Environment** / engine-specific sections in [.github/context/modules/agents.md](../context/modules/agents.md)
2. If a new adapter file was added (alternative LLM backend, e.g. `claudeAdapter.ts` or `aiderAdapter.ts`), add it to the agent inventory in `modules/agents.md`, the provider ids in `modules/plugins.md` / `modules/connectors.md`, and the source layout in `copilot-instructions.md`.
3. If the in-container headless CLI boot, worker timeout, or review-mode (`REVIEW_MODE=1`) execution changed, update the **Copilot Execution** / **Claude Execution** / **Aider Execution** sections in `copilot-instructions.md` and `modules/agents.md`.
4. If `AgentSession` or `TaskContext` (in `src/interfaces.ts`) gained/lost a field consumed by the agent, update the snippet in `modules/agents.md`.
5. Provider ids are `github | gitlab | gerrit | redmine | copilot | claude | aider | mock`. When adding an `agent_execution` engine, cover both its coding and review flows.
