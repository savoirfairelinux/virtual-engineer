# Virtual Engineer - Copilot Guidelines

This file is always loaded. Keep it limited to rules and facts that apply to
almost every task. Use [.github/context/INDEX.md](./context/INDEX.md) to route
task-specific questions to the canonical reference documents.

## Graphify

When `graphify-out/graph.json` exists, start codebase questions with:

```text
graphify query "<question>"
```

Use `graphify path "<A>" "<B>"` for relationships and `graphify explain
"<concept>"` for a focused concept. Use `graphify-out/wiki/index.md` for broad
navigation when it exists. After modifying code, run `graphify update .` to
keep the graph current. If the executable is unavailable, use the persisted
graph data or ordinary repository search without blocking the task.

## Documentation Ownership

When code changes, update the matching documentation in the same commit. The
file-scoped rules in [`.github/instructions/`](./instructions/) are the
authoritative ownership map:

| Code area | Canonical documentation |
|---|---|
| `src/state/schema.ts`, `src/state/databaseMigrations.ts`, `src/state/stateStore.ts`, `src/state/stores/**`, `src/state/migrate.ts` | [`context/database.md`](./context/database.md) |
| `src/state/stateMachine.ts`, `src/interfaces.ts`, `src/domain/tasks.ts` | [`context/state-machine.md`](./context/state-machine.md) |
| `src/config.ts` | [`context/configuration.md`](./context/configuration.md) |
| `src/agents/**`, `agent-worker/**` | [`context/modules/agents.md`](./context/modules/agents.md) |
| `src/connectors/**`, `src/vcs/**`, `src/plugins/**` | the matching connector, VCS, or plugin module doc |
| `src/admin/**` | [`context/modules/admin.md`](./context/modules/admin.md) |
| `src/orchestrator/**`, `src/review/**` | [`context/modules/orchestrator.md`](./context/modules/orchestrator.md) |
| `src/workspace/**` | [`context/architecture.md`](./context/architecture.md) and [`context/modules/workspace.md`](./context/modules/workspace.md) |
| `src/index.ts`, `src/bootstrap/**`, `src/runtime/**`, `src/openshell/**` | the affected architecture, runtime, workspace, agent, or database doc |
| `tests/**` | [`context/testing.md`](./context/testing.md) |
| project tooling configuration | this file's gates plus [`context/testing.md`](./context/testing.md) or [`context/configuration.md`](./context/configuration.md) |

Purely internal changes with no observable contract or behavior change do not
need documentation churn.

## Quality Gates

Run the relevant focused check first, then all three gates before a commit:

```text
npm test
npm run typecheck
npm run lint
```

Useful project commands include `npm run build:ui`, `npm run build:agent`,
`npm run db:migrate`, `npm run db:generate`, `npm run build`, and `npm run
dev`. See [`context/testing.md`](./context/testing.md) for test conventions.

## Non-negotiable Boundaries

- The orchestrator runs on the host. Agents run in ephemeral OpenShell
  sandboxes using upload -> exec -> download for coding and upload -> exec for
  review. There is no direct Docker workspace runner or named workspace volume.
- OpenShell runtime policies provide the isolation floor: deny-by-default
  filesystem, network, and process access; the `sandbox` user/group; and
  writable paths limited to `/sandbox`, `/tmp`, and `/dev/null`. Do not restore
  Docker security flags as a substitute.
- The host owns clone, checkout, cherry-pick, and push orchestration. The
  worker owns commit collection and Change-Id/trailer injection inside the
  sandbox. Push credentials never enter the sandbox. Provider commit behavior
  is governed by the provider-native runtime contract.
- Provider credentials and provider configuration live in the database and are
  managed through the admin UI. Do not add provider settings to environment
  variables or hardcode credentials.
- Multiple integrations of the same provider may be active. Resolve runtime
  dependencies by integration id, capability, or an explicit integration list;
  never assume one active integration per provider.
- Agent engines are Copilot, Claude, Aider, Goose, Codex, Gemini CLI, OpenCode,
  and Cursor. Their execution, auth, egress, prompt, and submission contracts
  live in [`context/modules/agents.md`](./context/modules/agents.md).

## Critical Invariants

- Timestamps are stored in seconds since epoch. Use
  `datetime(column, 'unixepoch')`, never divide by 1000.
- The `tasks` primary key is `task_id` (TEXT); there is no `tasks.id` column.
- Pause and resume are `state_transitions` rows with equal `from_state` and
  `to_state` plus `metadata.action`, not boolean task columns.
- State definitions and transitions are owned by `src/domain/tasks.ts`,
  `src/interfaces.ts`, and `src/state/stateMachine.ts`; consult
  [`context/state-machine.md`](./context/state-machine.md) before changing them.
- Database schema changes require a new immutable Drizzle migration. Never
  extend the frozen compatibility bridge or edit an applied migration.
- Runtime sandbox policies are separate from PBAC policies. Never reuse
  `policy_bindings` for OpenShell assignments.

## Canonical References

| Task | Read first |
|---|---|
| Architecture or data flow | [`context/architecture.md`](./context/architecture.md) |
| Database or migrations | [`context/database.md`](./context/database.md) |
| Configuration or environment | [`context/configuration.md`](./context/configuration.md) |
| Agent engine or sandbox behavior | [`context/modules/agents.md`](./context/modules/agents.md) |
| Workspace, Git hardening, or skill staging | [`context/modules/workspace.md`](./context/modules/workspace.md) |
| Connectors, VCS, or provider resolution | the matching doc in [`context/modules/`](./context/modules/) |
| Admin routes or PBAC | [`context/modules/admin.md`](./context/modules/admin.md) |
| Orchestrator or review lifecycle | [`context/modules/orchestrator.md`](./context/modules/orchestrator.md) |
| Tests and fixtures | [`context/testing.md`](./context/testing.md) |
| TypeScript implementation | [`skills/typescript-standard/SKILL.md`](./skills/typescript-standard/SKILL.md) |
| TDD implementation workflow | [`skills/ve-tdd/SKILL.md`](./skills/ve-tdd/SKILL.md) |
| Runtime debugging | [`skills/ve-debug/SKILL.md`](./skills/ve-debug/SKILL.md) |
| Multi-stage work | [`DEVELOPMENT-WORKFLOW.md`](./DEVELOPMENT-WORKFLOW.md) |

## TypeScript Conventions

- ESM with NodeNext requires `.js` import suffixes.
- Use strict TypeScript, `unknown` plus type guards instead of `any`, and
  explicit `T | undefined` for optional properties.
- Prefix intentionally unused locals and parameters with `_`.
- Type-aware lint covers `src/**/*.ts` and `agent-worker/src/**/*.ts`; heed
  `no-floating-promises`, `no-misused-promises`, and `no-unsafe-*` diagnostics.
- Follow the `ve-tdd` skill for tests and the `typescript-standard` skill for
  error handling, async behavior, and commit format.

## Commit Policy

Assistant-created or assistant-organized commits use the English Conventional
Commits policy in [the TypeScript skill](./skills/typescript-standard/SKILL.md).
When AI generated or materially contributed to the work, include a
`Co-authored-by:` trailer identifying the AI assistant. Provider-native commit
prompts are separate runtime contracts and must be updated with their provider
implementation rather than inferred from this assistant workflow rule.

## Recent Gotchas

- `getTaskByTicketId()` orders by newest `created_at`; do not reintroduce stale
  FAILED-task selection.
- Editing integrations hot-refreshes runtime dependencies; no orchestrator
  restart is needed.
- GitLab project selection belongs to project bindings (`ticketProjectKey` and
  `repoKey`), not new integration-form fields.
- Review tasks are integration-scoped and patchset-bound; never post effects
  for a stale patchset or choose the first repository from an ambiguous binding.
- Rebuild the agent image after changing an adapter, `agent-worker/src/**`, or
  `Dockerfile.agent`:

```text
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
```
