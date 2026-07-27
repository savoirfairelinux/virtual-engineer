---
name: ve-debug
description: "On-demand debug reference for the virtual-engineer project. Use when diagnosing runtime issues, state machine bugs, SQLite problems, or Gerrit/Redmine integration failures in this codebase. Provides correct SQLite queries, log pattern dictionary, known failure modes, and step-by-step debug procedures."
argument-hint: "Describe the symptom or paste the relevant log lines"
---
# Virtual Engineer Debug Reference

## SQLite Queries

```bash
# List all tasks with state
sqlite3 ./data/virtual-engineer.db \
  "SELECT task_id, ticket_id, state, cycle_count, failure_reason FROM tasks ORDER BY created_at DESC LIMIT 20;"

# Tasks for a specific ticket
sqlite3 ./data/virtual-engineer.db \
  "SELECT task_id, state, cycle_count, failure_reason, created_at FROM tasks WHERE ticket_id='<ID>' ORDER BY created_at DESC;"

# State transition history for a task (timestamps are stored in SECONDS)
sqlite3 ./data/virtual-engineer.db \
  "SELECT from_state, to_state, metadata, datetime(created_at, 'unixepoch') FROM state_transitions WHERE task_id='<TASK_ID>' ORDER BY id;"

# Pause/resume rows (from_state == to_state, metadata.action set)
sqlite3 ./data/virtual-engineer.db \
  "SELECT to_state, metadata, datetime(created_at, 'unixepoch') FROM state_transitions WHERE task_id='<TASK_ID>' AND from_state=to_state ORDER BY id DESC LIMIT 5;"

# Agent cycles for a task (includes streamed event log)
sqlite3 ./data/virtual-engineer.db \
  "SELECT cycle_number, agent_result, agent_events, datetime(created_at,'unixepoch') FROM agent_cycles WHERE task_id='<TASK_ID>' ORDER BY cycle_number;"

# Processed comments for a task
sqlite3 ./data/virtual-engineer.db \
  "SELECT gerrit_comment_id, datetime(created_at,'unixepoch') FROM processed_comments WHERE task_id='<TASK_ID>';"

# Count failures per ticket
sqlite3 ./data/virtual-engineer.db \
  "SELECT ticket_id, state, COUNT(*) as count FROM tasks GROUP BY ticket_id, state ORDER BY ticket_id;"

# Active integrations (admin-managed providers)
sqlite3 ./data/virtual-engineer.db \
  "SELECT id, provider, name, enabled, datetime(updated_at,'unixepoch') FROM integrations WHERE enabled=1 ORDER BY provider;"

# Editable prompts (system / instructions injection)
sqlite3 ./data/virtual-engineer.db \
  "SELECT id, label, length(content) AS bytes, datetime(updated_at,'unixepoch') FROM prompts;"
```

> Timestamps are stored as **seconds** since epoch (Drizzle `mode: "timestamp"`). Always use `datetime(col, 'unixepoch')`. Never divide by 1000.

## Log Pattern Dictionary

| Log message | Component | Meaning | Action |
|---|---|---|---|
| `ticket exceeded max retry attempts` | polling-loop | `failedAttemptsCount >= MAX_RETRY_ATTEMPTS`. Task will never restart. | Delete FAILED tasks for ticket in DB, or raise `MAX_RETRY_ATTEMPTS` in `.env` |
| `Invalid state transition: X → Y` | orchestrator | State machine rejected transition. Task left in limbo. | Check `stateMachine.ts` valid transitions. Task likely needs manual DB reset. |
| `no new actionable comments, back to IN_REVIEW` | orchestrator | Gerrit polling found no unresolved comments. Normal steady state. | Expected — not a bug |
| `fatal task error` | orchestrator | Unhandled exception in workflow. Check `err` field. | Read full error; often a state machine violation |
| `resuming active tasks` + `state: AGENT_RUNNING` | orchestrator | Restart while agent was running. Agent will re-run from scratch. | Normal recovery behavior |
| `copilot adapter: files written` | copilot-adapter | Agent produced output files. Next step: commit + push to Gerrit. | Normal |
| `change submitted to Gerrit, task is now IN_REVIEW` | orchestrator | Success — patchset pushed. | Normal |

## Known Failure Modes

### Ticket stuck at `maxAttempts: 2`
**Cause:** Old process ran before `MAX_RETRY_ATTEMPTS=5` fix was deployed; DB has 2+ FAILED tasks.  
**Fix:** Add `MAX_RETRY_ATTEMPTS=5` (or higher) to `.env`. The count check reads the env at startup.  
**Or:** Delete the extra FAILED tasks: `DELETE FROM tasks WHERE ticket_id='X' AND state='FAILED' AND task_id != '<keep_this_id>';`

### `Invalid state transition: FAILED → IN_REVIEW`
**Cause:** Task was previously marked FAILED (e.g. prior crash), then restarted and agent succeeded, but `runAgentCycle` tries to transition to `IN_REVIEW` from `FAILED`.  
**Root cause:** `getTaskByTicketId` returned a stale FAILED task instead of the new DETECTED task.  
**Fix:** Already fixed — `getTaskByTicketId` now uses `ORDER BY created_at DESC`.

### Two tasks active for same ticket
**Cause:** Race between two poll cycles calling `startTask` concurrently.  
**Fix:** Already fixed — partial unique index `idx_tasks_active_ticket_id` prevents duplicate active tasks at DB level.

### Comments perpetually "no new actionable comments"
**Cause A:** Comments are resolved in Gerrit — correct behavior.  
**Cause B:** Comment was marked processed locally but `resolveComments` in Gerrit never completed (crash between the two operations).  
**Fix:** Already fixed — `checkReviewProgress` now re-attempts `resolveComments` for comments in `processedCommentIds` that are still unresolved in Gerrit.

## Debug Procedure

1. **Capture the symptom** — Find the exact ERROR or unexpected log sequence. Note the `taskId`.
2. **Get task state from DB** — Run the "tasks for specific ticket" query above.
3. **Get state transition history** — Run the transition history query for the task.
4. **Match to known failure modes** — Check table above.
5. **If unknown** — Search source: `grep -r "the exact error string" src/`
6. **Fix in source** — Make the minimal change.
7. **Add regression test** — Test must fail before fix, pass after.
8. **Verify** — `npm test && npm run typecheck`

## Architecture Quick Reference

```
ticket poll (project mode) ─→ pollingLoop ─→ orchestrator ─→ workspaceRunner ─→ ephemeral container
                     ↕                                  (edits files, may commit)
                   stateStore (SQLite/Drizzle)             ↓
                     ↕                             host push via src/vcs/
review intake (webhook / Gerrit stream-event / poll) ─→ review trigger ─→ reviewOrchestrator ─→ workspaceRunner.runReviewInDocker (agent container, REVIEW_MODE=1)
                     ↕
               pluginManager (resolves integrations / connectors)
                     ↕
               adminServer (HTTP, dashboard, refreshRuntimeDependencies)
```

Source files:
- `src/orchestrator/orchestrator.ts` — state machine driver
- `src/orchestrator/pollingLoop.ts` — project-aware ticket polling
- `src/orchestrator/feedbackProcessor.ts` — review comment dedup
- `src/state/stateStore.ts` — all SQLite operations
- `src/state/stateMachine.ts` — `VALID_TRANSITIONS`
- `src/state/schema.ts` — tasks, integrations, prompts, agents, projects, project_* tables, concurrency, change tracking
- `src/agents/copilotAdapter.ts` — Copilot container spec (`buildContainerSpec`)
- `src/agents/claudeAdapter.ts` — Claude Code container spec
- `src/agents/aiderAdapter.ts` — Aider container spec
- `src/agents/copilotConnectionValidator.ts` — token-backed Copilot validation plus container fallback
- `src/agents/claudeConnectionValidator.ts` / `src/agents/aiderConnectionValidator.ts` — Claude / Aider connection validators
- `src/review/reviewOrchestrator.ts` — code-review lifecycle
- `src/connectors/{redmine,gerrit,gitlabIssue,gitlabMergeRequest,githubIssue,githubPullRequestReview}Connector.ts`
- `src/vcs/{gerrit,gitlab,github}VcsConnector.ts` + `vcsFactory.ts`
- `src/plugins/` — registry, pluginManager, descriptors
- `src/admin/` — admin HTTP server + dashboard
