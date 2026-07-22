# Development Workflow

Guidance for using VS Code custom agents to plan and execute features or fixes following TDD and quality best practices. You steer the workflow; the coordinator and specialized agents assist at each stage.

## Overview

```text
You: describe task → Coordinator: clarify & propose stages → You: approve
  → Coordinator + agents execute stages in sequence (you approve at key gates,
    loop back when results are unsatisfactory)
  → Final result: ready-to-review commits
```

## Starting the Workflow

1. **Open Copilot Chat** in VS Code
2. **Select agent**: `dev-coordinator`
3. **Describe your task**:

   ```text
   Type: feature
   Build: Add support for priority levels in tickets
   Location: Redmine connector, state machine, orchestrator
   Constraints: Must be backwards compatible
   ```

4. The coordinator will ask clarifying questions and propose a workflow

## Typical Workflow Stages

**Not all stages are needed for every task.** The coordinator helps you decide. The full pipeline:

| # | Stage | Agent | Purpose / Output |
| --- | ----- | ----- | ---------------- |
| 1 | Pre-Planning | dev-preplanner | Quick viability scan: scope, blockers |
| 2 | Planning | dev-planner | 3-5 phase implementation plan |
| 3 | Plan Validation | dev-plan-validator | Check plan against codebase patterns & dependencies |
| 4 | Implementation (TDD) | tested-engineer | Tests first, then code; all gates green |
| 5 | Security Review | dev-security-auditor | OWASP review + secret scan |
| 6 | Commit Organization | dev-commit-expert | Conventional Commits ready to push |

The coordinator may re-run the quality gates itself (`npm test`, `npm run typecheck`, `npm run lint`) after implementation or loop-back fixes. Documentation sync happens in the same commits via `.github/instructions/*.instructions.md` rules.

## Key Decision Points

- **After Planning** — does the approach match your vision? Architecture concerns?
- **After Plan Validation** — conflicts with existing patterns or hidden dependencies?
- **After Implementation** — all tests pass? Type-check and lint clean? Regressions?
- **After Security Review** — high/critical findings or secrets that block progress?

## Looping Back

If any stage produces unsatisfactory results:

1. **Show feedback** to the coordinator (e.g., "Tests are failing, let's adjust approach")
2. **Coordinator re-invokes** that stage or a prior stage with updated context
3. **Repeat** until results are acceptable — there is no automatic retry cap; escalation is your call

## How Handoffs Work

- **Handoffs** — agents define explicit transitions to next agents via `handoffs:` in frontmatter; `send: false` means you approve before the handoff happens
- **Context in prompts** — the coordinator gathers context from prior stages and passes it explicitly in handoff prompts
- **Approval remains explicit** — you decide what requires approval based on the results shown

## Example: Add a Fallback Model for Redmine Connector

```text
User: Type: fix
      Build: Redmine connector should retry with fallback model if primary fails
      Location: src/connectors/redmineConnector.ts
      Constraints: No performance regression; 3s total timeout

Coordinator: I propose:
  1. Pre-planner scans for recent changes to redmineConnector
  2. Planner designs retry + fallback logic
  3. Plan validator checks the design against existing connector patterns
  4. tested-engineer writes failing tests, then the retry code
  5. Security auditor reviews the changes (including secret scan)
  6. Commit expert organizes commits
  
Sound good?

User: Yes, let's go.
[Coordinator delegates stage by stage; after each, shows results and asks: proceed or adjust?]
```

## Tips

1. **Be specific** — vague tasks lead to more iterations
2. **Review each stage's output** — don't just approve blindly
3. **Speak up early** — if a stage's approach doesn't feel right, let the coordinator know
4. **Use the conversation** — all context is in the chat; refer back to earlier findings if looping
5. **Check the code** — after implementation, review the actual changes before approving

## Agents Available

All agent definitions live under [.github/agents/](./agents/). The full inventory:

| Agent | Role | Status |
| ----- | ---- | ------ |
| `tested-engineer` | Full TDD cycle: tests + implementation + validation | User-invocable |
| `log-debugger` | Diagnoses runtime errors, writes regression tests | User-invocable |
| `codebase-analyst` | Read-only code audit and issue detection | User-invocable |
| `doc-engineer` | Generates AI-consumable documentation | User-invocable |
| `doc-auditor` | Read-only drift check: docs vs. actual code | User-invocable |
| `dev-coordinator` | Orchestrates multi-stage workflow, runs quality gates | User-invocable |
| `dev-preplanner` | Quick viability and risk assessment | Subagent |
| `dev-planner` | Designs detailed implementation plan (3–5 phases) | Subagent |
| `dev-plan-validator` | Validates plan against actual codebase | Subagent |
| `dev-security-auditor` | OWASP vulnerability review + secret scan | Subagent |
| `dev-commit-expert` | Conventional Commits organization (final stage) | Subagent |
| `explore` | Fast read-only exploration / Q&A | User-invocable |

## See Also

- [TypeScript Standard](skills/typescript-standard/SKILL.md) — Code style and patterns for this project
- [VE Debug](skills/ve-debug/SKILL.md) — Debugging guide for the virtual-engineer project
- [VE TDD](skills/ve-tdd/SKILL.md) — TDD workflow specifics
