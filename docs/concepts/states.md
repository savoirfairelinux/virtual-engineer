# Task states

One state machine for both workflows.

Both task types share one `TaskState` enum and one persisted transition map. `validateTransition()` returns `idempotent` for a self-edge, `valid` for a legal edge, and throws `InvalidTransitionError` otherwise or when the source state is terminal.

| State | Meaning |
| --- | --- |
| `DETECTED` | New code-gen task created from a ticket |
| `CONTEXT_BUILDING` | Loading ticket, project, and push-target context |
| `AGENT_RUNNING` | Agent is editing files and may create local commits |
| `IN_REVIEW` | Change submitted to Gerrit, GitLab, or GitHub |
| `FEEDBACK_PROCESSING` | Deduplicating and normalizing review comments |
| `RETRY_CYCLE` | Preparing the next cycle with prior feedback |
| `MERGED` | External review reports the change merged |
| `CLOSING` | Closing the originating ticket |
| `DONE` | Successful completion |
| `FAILED` | Unrecoverable failure |
| `ABANDONED` | Manual abandon, or a no-change outcome |
| `REVIEW_PENDING` | Review task created, awaiting agent execution |
| `REVIEW_RUNNING` | Review agent analyzing a patchset |
| `REVIEW_COMMENTING` | Posting comments and the vote back |
| `REVIEW_WATCHING` | Waiting for a follow-up patchset or a terminal outcome |
| `REVIEW_DONE` | Review completed cleanly |
| `REVIEW_FAILED` | Review flow failed irrecoverably |

## Pause, resume, restart

There are no boolean pause columns. `pauseTask()` and `resumeTask()` append a `state_transitions` row where `from_state == to_state` and `metadata.action` is `pause` or `resume`, so both live in the same audit trail.

On restart, `resumeActiveTasks()` resumes non-terminal code-gen tasks only. `AGENT_RUNNING` restarts from scratch because the sandbox is ephemeral, and `FEEDBACK_PROCESSING` stays idempotent because processed comments are persisted.

The full edge list is in [Reference → States](../reference/ref-states.md).
