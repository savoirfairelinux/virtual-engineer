# AGENTS.md — Virtual Engineer

Vendor-neutral entry point for AI coding assistants (Codex, Cursor, Aider, Gemini CLI, OpenCode, Claude Code, GitHub Copilot, and others). This file is intentionally short; it orients you and points to the shared knowledge base. **Do not duplicate content here — link to the single source of truth.**

## What this project is

Virtual Engineer is a host-side Node.js/TypeScript orchestrator with two flows:

- **Coding agent** — picks up assigned tickets, runs an agent cycle in a hardened, ephemeral **Docker** container, and pushes the result for review.
- **Review agent** — on every new/updated patchset (Gerrit stream-event, GitLab/GitHub webhook, or poll), runs the agent in the same container (`REVIEW_MODE=1`) and posts comments + a vote.

All provider configuration lives in SQLite and is managed through the admin UI. The agent engine is pluggable: **Copilot**, **Claude**, **Aider**, or **Mock**.

## Knowledge base (read before non-trivial work)

| You need… | Read |
|---|---|
| Repo-wide conventions, schema facts, gotchas | [.github/copilot-instructions.md](.github/copilot-instructions.md) — the primary, always-loaded reference (vendor-agnostic despite the filename) |
| Navigable context index | [.github/context/INDEX.md](.github/context/INDEX.md) |
| Architecture / data flow | [.github/context/architecture.md](.github/context/architecture.md) |
| State machine | [.github/context/state-machine.md](.github/context/state-machine.md) |
| Database schema | [.github/context/database.md](.github/context/database.md) |
| Configuration / env vars | [.github/context/configuration.md](.github/context/configuration.md) |
| Module deep-dives | [.github/context/modules/](.github/context/modules/) |
| Coding standards (TypeScript) | [.github/skills/typescript-standard/SKILL.md](.github/skills/typescript-standard/SKILL.md) |
| TDD workflow | [.github/skills/ve-tdd/SKILL.md](.github/skills/ve-tdd/SKILL.md) |
| Runtime debugging | [.github/skills/ve-debug/SKILL.md](.github/skills/ve-debug/SKILL.md) |
| Multi-stage feature workflow + agent roster | [.github/DEVELOPMENT-WORKFLOW.md](.github/DEVELOPMENT-WORKFLOW.md) |

## Quality gates (run before every commit)

```bash
npm test            # Vitest — all unit + integration tests must pass
npm run typecheck   # zero TS errors (tsconfig.json + tsconfig.agent.json)
npm run lint        # zero ESLint errors (src, tests, agent-worker/src)
```

Also: `npm run dev` (start orchestrator), `npm run build:ui` (admin SPA), `npm run db:migrate` (migrations).

## Non-negotiables

- **Test-driven**: write or extend a failing test before production code. See the `ve-tdd` skill.
- **TypeScript strict**: no `any` in `src/`; ESM with NodeNext (`.js` import suffix); respect `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`.
- **Docs auto-sync**: when you change code, update the matching docs in the **same commit**. The per-area rules live in [.github/instructions/](.github/instructions/) with `applyTo` globs; the mapping table is in [.github/copilot-instructions.md](.github/copilot-instructions.md).
- **Conventional Commits**, Gerrit-friendly: `<type>(<scope>): <≤50-char subject>`. Scopes and types are listed in the `typescript-standard` skill.
- **Secrets & safety**: provider credentials live in the DB, never in env or code. Never commit secrets. Confirm before destructive/irreversible actions.

## Critical facts (memorise)

- Timestamps are stored in **seconds** → `datetime(col, 'unixepoch')`, never `col / 1000`.
- `tasks` primary key is `task_id` (TEXT); there is **no** `id` column.
- Pause/resume are `state_transitions` rows where `from_state == to_state` (metadata `action`), not boolean columns.
- Agents run in **ephemeral, hardened Docker containers** with named volumes (`/workspace`, `/ve-home`); the host owns push credentials.
- Editing an integration hot-refreshes runtime deps — no orchestrator restart needed.
- Rebuild the agent image after touching `src/agents/copilotAdapter.ts`, `src/agents/claudeAdapter.ts`, `src/agents/aiderAdapter.ts`, `agent-worker/src/**`, or `Dockerfile.agent`:
  `docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .`
