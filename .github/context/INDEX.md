# Virtual Engineer — Context Index

This folder contains AI-consumable reference docs for the Virtual Engineer codebase. Start here, then jump to the section relevant to your task.

> **Navigation hierarchy**: [AGENTS.md](../../AGENTS.md) (vendor-neutral orientation) → [copilot-instructions.md](../copilot-instructions.md) (always-loaded primary reference) → **this index** (on-demand deep-dives). Every doc below ends with a **Related docs** block linking back here and to its siblings.

The repo-wide entry point for Copilot is [.github/copilot-instructions.md](../copilot-instructions.md). It is loaded automatically; this folder is loaded **on demand**.

## Documents

### Core

| File | Purpose |
|---|---|
| [architecture.md](architecture.md) | Layered architecture, data flow, module map, container hardening |
| [state-machine.md](state-machine.md) | All states, the full transition map, pause/resume, retry caps, side effects |
| [database.md](database.md) | Every SQLite table + column; common queries; migrations |
| [configuration.md](configuration.md) | Every env var with defaults; conditional-required rules; layered config |
| [testing.md](testing.md) | Vitest layout (unit + integration, no e2e); conventions; gates |
| [gitlab-integration.md](gitlab-integration.md) | Reference for the implemented GitLab providers |

### Modules

| File | Covers |
|---|---|
| [modules/orchestrator.md](modules/orchestrator.md) | `orchestrator.ts`, `pollingLoop.ts`, `feedbackProcessor.ts` |
| [modules/agents.md](modules/agents.md) | `copilotAdapter`, `claudeAdapter`, `aiderAdapter`, `mockAgentAdapter`, agent worker, auth, validators, cycle cost |
| [modules/connectors.md](modules/connectors.md) | Redmine, GitLab Issues, GitHub Issues, Gerrit, GitLab MR, GitHub PR connectors |
| [modules/vcs.md](modules/vcs.md) | Host-owned direct push (Gerrit / GitLab / GitHub), branch naming |
| [modules/plugins.md](modules/plugins.md) | Descriptor registry, PluginManager, runtime bootstrap |
| [modules/admin.md](modules/admin.md) | Admin HTTP server + dashboard, secret masking, integration test endpoint |

## Quick task → doc map

- **Add or change a state** → [state-machine.md](state-machine.md) + [modules/orchestrator.md](modules/orchestrator.md).
- **Add a column or table** → [database.md](database.md), update `src/state/schema.ts`, run `npm run db:generate`.
- **Add an env var** → [configuration.md](configuration.md), update `src/config.ts` (`ConfigSchema` + `fromEnv`).
- **Add a new provider** → matching `modules/*.md` (connectors / vcs / plugins / agents).
- **Add a new agent engine** → [modules/agents.md](modules/agents.md) + the descriptor's `agent_execution` capability (see [modules/plugins.md](modules/plugins.md)).
- **Run tests** → [testing.md](testing.md).
- **Debug a stuck task** → SQL queries in [database.md](database.md) + the [`ve-debug` skill](../skills/ve-debug/SKILL.md).
- **Debug Copilot execution** → [modules/agents.md](modules/agents.md) (in-container `copilot --headless`; reviews via `REVIEW_MODE=1`) + [copilot-instructions.md](../copilot-instructions.md).

## Cross-cutting facts (worth memorising)

- Timestamps are stored in **seconds**: use `datetime(col, 'unixepoch')`, never `col/1000`.
- `tasks` PK = `task_id` (TEXT). No `id` column.
- Pause/resume are `state_transitions` rows where `from_state == to_state`, with `metadata.action`.
- The orchestrator runs on the **host**; the agent runs in an **ephemeral, hardened** Docker container. The worker creates or normalizes commits in-container; the host retains credentials and pushes those commits via `src/vcs/`.
- Provider selection is per-integration via the `integrations` table; multiple integrations of the same provider can be active simultaneously.
- Agent engines (`agent_execution`) are **Copilot**, **Claude**, **Aider**, or **Mock**. Copilot defaults to model `auto`; Claude and Aider have no hardcoded default (their CLIs pick one when no model is set).
