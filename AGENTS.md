# AGENTS.md — Virtual Engineer

Vendor-neutral entry point for AI coding assistants (Codex, Cursor, Aider, Gemini CLI, OpenCode, Claude Code, GitHub Copilot, and others). This file is intentionally short; it orients you and points to the shared knowledge base. **Do not duplicate content here — link to the single source of truth.**

## What this project is

Virtual Engineer is a host-side Node.js/TypeScript orchestrator with two flows:

- **Coding agent** — picks up assigned tickets, runs an agent cycle in an ephemeral **OpenShell sandbox**, and pushes the result for review.
- **Review agent** — on every new/updated patchset (Gerrit stream-event, GitLab/GitHub webhook, or poll), runs the agent in the same sandbox (`REVIEW_MODE=1`) and posts comments + a vote.

All provider configuration lives in SQLite and is managed through the admin UI. The agent engine is pluggable: **Copilot**, **Claude**, **Aider**, **Goose**, **Codex**, **Gemini CLI**, **OpenCode**, or **Cursor**.

## Knowledge base (read before non-trivial work)

| You need… | Read |
|---|---|
| Repo-wide routing, quality gates, invariants, gotchas | [.github/copilot-instructions.md](.github/copilot-instructions.md) — the primary, always-loaded reference (vendor-agnostic despite the filename) |
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

Use the canonical gate commands documented in:
- [.github/copilot-instructions.md](.github/copilot-instructions.md) (repo-wide default)
- [.github/skills/ve-tdd/SKILL.md](.github/skills/ve-tdd/SKILL.md) (implementation workflow)

Common operational commands (`npm run dev`, `npm run build:ui`, `npm run db:migrate`) are documented in the context files linked above.

## Non-negotiables

- **Test-driven**: write or extend a failing test before production code. See the `ve-tdd` skill.
- **TypeScript strict**: no `any` in `src/`; ESM with NodeNext (`.js` import suffix); respect `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`.
- **Docs auto-sync**: when you change code, update the matching docs in the **same commit**. The per-area rules live in [.github/instructions/](.github/instructions/) with `applyTo` globs; the mapping table is in [.github/copilot-instructions.md](.github/copilot-instructions.md).
- **Commit policy**: assistant-created or assistant-organized commits use English Conventional Commits and include a `Co-authored-by:` trailer when AI generated or materially contributed to the work. See the [`typescript-standard` skill](.github/skills/typescript-standard/SKILL.md) for the canonical format and scopes.
- **Secrets & safety**: provider credentials live in the DB, never in env or code. Never commit secrets. Confirm before destructive/irreversible actions.

## Critical facts

Keep `.github/copilot-instructions.md` as the canonical source for invariants
and boundaries. Do not duplicate those lists here.
