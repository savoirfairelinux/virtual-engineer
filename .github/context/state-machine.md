# State Machine Reference

**Source of truth:** [src/state/stateMachine.ts](../../src/state/stateMachine.ts), [src/interfaces.ts](../../src/interfaces.ts), [src/state/stateStore.ts](../../src/state/stateStore.ts).

`TaskState` is shared by two task types:

- `taskType = "code-gen"` for the ticket-driven coding workflow.
- `taskType = "code-review"` for VE-as-reviewer tasks.

## States

| State | Kind | Meaning |
|---|---|---|
| `DETECTED` | active | New code-gen task created from a ticket |
| `CONTEXT_BUILDING` | active | Loading ticket + project/push-target context |
| `AGENT_RUNNING` | active | Agent container is editing files and may create local commits |
| `IN_REVIEW` | active | Code-gen change submitted to Gerrit / GitLab MR |
| `FEEDBACK_PROCESSING` | active | Deduplicating and normalizing review comments |
| `RETRY_CYCLE` | active | Preparing the next code-gen cycle with prior feedback |
| `MERGED` | active | External review reports merged |
| `CLOSING` | active | Closing the originating ticket |
| `DONE` | terminal | Successful code-gen completion |
| `FAILED` | terminal | Unrecoverable code-gen failure |
| `ABANDONED` | terminal | Manual abandon or no-change outcome |
| `REVIEW_PENDING` | active | Code-review task created, awaiting agent execution |
| `REVIEW_RUNNING` | active | Review agent analyzing a patchset |
| `REVIEW_COMMENTING` | active | Posting comments / vote back to the review system |
| `REVIEW_WATCHING` | active | Waiting for a follow-up patchset or terminal review outcome |
| `REVIEW_DONE` | terminal | Review completed cleanly |
| `REVIEW_FAILED` | terminal | Review flow failed irrecoverably |

## Valid Transitions (`VALID_TRANSITIONS`)

```text
DETECTED            → CONTEXT_BUILDING | FAILED
CONTEXT_BUILDING    → AGENT_RUNNING | FAILED
AGENT_RUNNING       → IN_REVIEW | RETRY_CYCLE | FAILED | ABANDONED
IN_REVIEW           → FEEDBACK_PROCESSING | MERGED | ABANDONED | FAILED
FEEDBACK_PROCESSING → RETRY_CYCLE | IN_REVIEW | FAILED | ABANDONED
RETRY_CYCLE         → AGENT_RUNNING | ABANDONED | FAILED
MERGED              → CLOSING | DONE | FAILED
CLOSING             → DONE | FAILED

REVIEW_PENDING      → REVIEW_RUNNING | REVIEW_FAILED
REVIEW_RUNNING      → REVIEW_COMMENTING | REVIEW_FAILED
REVIEW_COMMENTING   → REVIEW_WATCHING | REVIEW_DONE | REVIEW_FAILED
REVIEW_WATCHING     → REVIEW_RUNNING | REVIEW_DONE | REVIEW_FAILED

DONE | FAILED | ABANDONED | REVIEW_DONE | REVIEW_FAILED → (terminal)
```

`validateTransition(from, to)` returns:

- `"idempotent"` when `from === to`
- `"valid"` when the edge exists
- `InvalidTransitionError` when the edge is illegal or `from` is terminal

## Pause / Resume

There are **no boolean columns**. `pauseTask()` / `resumeTask()` append a `state_transitions` row with `from_state == to_state` and `metadata.action = "pause" | "resume"`.

## Cycle counting & retry caps

| Limit | Default | Source | Behaviour |
|---|---|---|---|
| `MAX_AGENT_CYCLES` | 3 | `src/config.ts` | Applies to ticket-driven code-gen tasks. When exceeded before re-entering `AGENT_RUNNING`, the task moves to `FAILED`. |
| `MAX_RETRY_ATTEMPTS` | 5 | `src/config.ts` | Polling skips a ticket once prior `FAILED` + `ABANDONED` attempts for the same ticket/source reach the cap. |

`getTaskByTicketId()` orders by `created_at DESC`, so polling always sees the newest task row first.

## Side effects per transition

The state machine is pure. Side effects live in orchestrators.

### Code-gen flow

Implemented primarily in [src/orchestrator/orchestrator.ts](../../src/orchestrator/orchestrator.ts).

| Transition | Effect |
|---|---|
| `→ CONTEXT_BUILDING` | Fetch ticket details and resolve project-aware repository context |
| `→ AGENT_RUNNING` | Clone workspace, build `TaskContext`, launch agent container |
| `→ IN_REVIEW` | Push host-managed review objects or agent-created commit chain via VCS layer |
| `→ FEEDBACK_PROCESSING` | Deduplicate external comments via `feedbackProcessor` + `processed_comments` |
| `→ RETRY_CYCLE` | Rebuild context with prior feedback |
| `→ MERGED` | Mark merged and advance toward ticket closure |
| `→ CLOSING` | Post completion note and close ticket |
| `→ FAILED` / `→ ABANDONED` | Persist `failure_reason` and update ticket state accordingly |

### Code-review flow

Implemented in [src/review/reviewOrchestrator.ts](../../src/review/reviewOrchestrator.ts).

| Transition | Effect |
|---|---|
| `REVIEW_PENDING → REVIEW_RUNNING` | Load change details, build review prompt, run review agent |
| `REVIEW_RUNNING → REVIEW_COMMENTING` | Parse result and prepare outbound comments / vote |
| `REVIEW_COMMENTING → REVIEW_WATCHING` | Persist the review pass and wait for the next patchset/outcome |
| `REVIEW_COMMENTING → REVIEW_DONE` | Finish immediately when the change is already terminal |
| `REVIEW_WATCHING → REVIEW_RUNNING` | Re-enter on a newer patchset |
| `→ REVIEW_FAILED` | Persist failure reason and stop the review task |

## Audit trail

Every state transition writes a row in `state_transitions`:

```sql
SELECT from_state, to_state, metadata,
       datetime(created_at, 'unixepoch') AS at
FROM state_transitions
WHERE task_id = 'X'
ORDER BY id;
```

## Restart semantics

- `Orchestrator.resumeActiveTasks()` only resumes non-terminal **code-gen** tasks.
- Code-review tasks are re-entered through the review runtime (`ReviewOrchestrator`) or admin retry/resume controls.
- `AGENT_RUNNING` is restart-from-scratch; the container is ephemeral.
- `FEEDBACK_PROCESSING` stays idempotent because processed comments are persisted.

## Adding a new state

1. Add it to `TASK_STATES` in [src/interfaces.ts](../../src/interfaces.ts).
2. Update `TERMINAL_STATES` if needed.
3. Add edges in [src/state/stateMachine.ts](../../src/state/stateMachine.ts).
4. Implement side effects in the owning runtime: [src/orchestrator/orchestrator.ts](../../src/orchestrator/orchestrator.ts) for code-gen, or [src/review/reviewOrchestrator.ts](../../src/review/reviewOrchestrator.ts) for code-review.
5. Cover transitions and rejection paths in [tests/unit/stateMachine.test.ts](../../tests/unit/stateMachine.test.ts) and the relevant orchestrator/review tests.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [architecture.md](architecture.md) — layered architecture and data flow
- [database.md](database.md) — `tasks`, `state_transitions` schema
- [modules/orchestrator.md](modules/orchestrator.md) — side effects per transition
- [configuration.md](configuration.md) — `MAX_AGENT_CYCLES`, `MAX_RETRY_ATTEMPTS`
