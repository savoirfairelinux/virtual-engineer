# Modules — Orchestrator

**Source:** [src/orchestrator/](../../../src/orchestrator/).

This module set covers the **ticket-driven code-generation runtime**. The separate VE-as-reviewer flow lives in [src/review/](../../../src/review/).

## Review execution — `src/review/reviewOrchestrator.ts`

- A review result is bound to the patchset used for checkout, diff construction, prompt construction, and agent execution. Immediately before provider effects, `runReview()` fetches fresh change details and posts only when both the patchset still matches and the change remains `OPEN`.
- Copilot and Claude submit their typed result through the worker-owned `ve_submit_review` MCP tool; Aider retains the delimited JSON fallback. In both cases `parseReviewResult()` remains the host-side authority before filtering, deduplication, comments, replies, or votes. The MCP server never performs provider effects itself.
- When a newer patchset arrives during analysis, the completed cycle is retained with `metadata.superseded = true`, while provider and posting-ledger effects are skipped. The task records the latest patchset and starts a fresh internal pass; repeated supersession is bounded to three retries before `REVIEW_FAILED`.
- When the change becomes merged or abandoned during analysis, the discarded cycle is retained and the task finishes at `REVIEW_DONE` without comments, replies, vote, ledger writes, or `reviewedPatchset` advancement.
- `REVIEW_COMMENTING` is entered before the first provider call. It therefore means remote effects may be partially applied and must not be blindly replayed after a restart; `reviewedPatchset` and the successful cycle metadata are the local completion signals.
- Every provider and ledger effect re-checks that the task remains active. An abandoned or otherwise inactive task stops the current pass and any pending supersession rerun without being rewritten as `REVIEW_FAILED`.
- Startup recovery is separate from code-gen `resumeActiveTasks()`: `recoverActiveReviews()` concurrently builds the review runtime for each active review task, replays `REVIEW_PENDING`, resumes an orphaned `REVIEW_RUNNING` task in its existing running cycle without incrementing the count, reconciles completed `REVIEW_COMMENTING`, and leaves `REVIEW_WATCHING` to the status poller. Review recovery, code-generation recovery, and initial workspace reconciliation also start concurrently so one slow task cannot serialize unrelated recovery. Review credentials, model, adapter, and concurrency identity all resolve from the task project's selected agent integration; a missing, disabled, invalid, or inactive project agent makes the task `REVIEW_FAILED`, and the Docker runner requires that exact adapter instead of falling back to its process-wide adapter. Workspace/agent execution waits on the same integration-scoped `ConcurrencyTracker` used by code generation, so concurrent recovery cannot exceed that agent's `maxConcurrent`. An ambiguous `REVIEW_COMMENTING` becomes `REVIEW_FAILED` with an explicit partial-provider-effects reason rather than replaying comments or votes; a successful cycle explicitly archived because the change became `MERGED` or `ABANDONED` safely finalizes as `REVIEW_DONE`.
- A review pass claims `REVIEW_RUNNING` before allocating a cycle or invoking the provider. Concurrent triggers that lose this claim return without side effects, so one patchset cannot create duplicate agent runs.
- One review deadline starts before provider details/diff and remains active through capacity queueing, abortable workspace creation/clone/patch checkout, agent execution, freshness checks, comments/replies/vote, ledger persistence, and final provider status. Signal-aware workspace operations are awaited to termination before cleanup. A timeout after entering `REVIEW_COMMENTING` preserves that ambiguous state for restart recovery instead of claiming provider effects did not happen.
- Each new review pass atomically allocates its cycle number and persists an explicit `running` row through `startAgentCycle`, then replaces that row with the final success/failure payload. Inactive-task cancellation also finalizes the row with a visible reason, so completed tasks cannot retain a stale running cycle.

## `Orchestrator` — `orchestrator.ts`

`Orchestrator` owns the code-gen task lifecycle. It builds `TaskContext`, invokes the selected agent adapter, persists results, and coordinates VCS / review feedback.

Key public methods:

- `startTaskForProject(ticket, project, ticketSourceLabel)`
- `resumeActiveTasks()`
- `handleReviewEvent(changeId)`
- `triggerFeedbackForChange(integrationId, externalChangeId)`
- `markChangeMerged(integrationId, externalChangeId)`
- `markChangeAbandoned(integrationId, externalChangeId)`
- `abandonTask(taskId)` / `deleteProject(projectId)` for lifecycle-owned admin mutations

Important behaviors:

- project-aware task creation stores `projectId` on the task row
- project-mode agent execution resolves the adapter exclusively through `project.agentId -> agents.integrationId`; a missing, disabled, non-coding, unlinked, or inactive project agent fails the task before `runAgent()` and never falls back to the process-wide runtime adapter
- when that project-linked agent is active, `runAgentCycle()` also applies `resolveAgentConfig(agent, project)` to the `TaskContext`, so per-project Copilot model, GitHub token, CLI URL, and prompt ids flow into the agent without changing the integration routing
- project-mode ticket/review/VCS resolution can build project-bound connectors from the active integration plus VE-owned binding context; GitLab therefore reads ticket project selection from the `issue_tracking` binding's `ticketProjectKey` and MR/push project selection from the relevant `repoKey` rather than from integration-global `projectId`
- `runWorkflow()` is state-driven and restart-safe; an interrupted `AGENT_RUNNING` task with a persisted running result resumes that same cycle instead of consuming another cycle number
- one shared `TaskLifecycleCoordinator` serializes code-gen workflows, review passes, polling/webhooks, manual abandon, and project deletion. Review cancellation aborts and awaits provider/agent work before the admin mutation. Project deletion first tombstones the project against both code-gen and review task creation, waits any in-progress creation lease, then cancels and barriers every project task before removing rows; stale invocations for deleted task ids are suppressed
- webhook merge handling is dual-path: code-gen tasks in `IN_REVIEW` transition through `MERGED -> CLOSING -> DONE`, while review tasks in `REVIEW_WATCHING` transition directly to `REVIEW_DONE`
- fatal ticket handling is provider-agnostic: missing resources are detected via `TicketNotFoundError`, and non-fatal ticket API failures are handled via `TicketApiError` from `src/interfaces.ts`
- review feedback for code-gen tasks is deduplicated via `processed_comments`
- project pushes always require `VcsConnector.pushDirect()` and preserve the worker-normalized agent commit chain; `AgentResult.commits[]` supplies per-commit metadata for multi-change tracking
- the worker-owned `ve_submit_changes` MCP tool is a typed completion intent, not a push API. Commit collection, validation, Change-Id injection, `pushDirect()`, `change_per_repository` persistence, and state transitions still occur only after the agent container exits
- coding projects may override the ticket-derived Gerrit topic with `gerritTopicOverride`; otherwise the existing `VE-<task>-<title>` topic remains unchanged
- `useFullTicketUrlInCommits` formats a full ticket URL trailer and passes it through `AgentSession.ticketFooterLine` so direct-pushed agent commits receive it inside the worker
- `postReviewLinkToTicket` posts the first cycle's non-orphaned review URLs back to the source ticket; later cycles reuse those reviews and do not post another note
- `reactToCiFailures` controls whether comments tagged as GitHub `ci-run-*` or Gerrit `ci-failure-*` become retry feedback; the default remains off
- Gerrit push chains are tracked in `change_per_repository` with `commitIndex` and `subjectHash`
- orphaned prior changes are marked `ORPHANED` and excluded from merge convergence; `orphanExcessChanges()` automatically marks rows with `commitIndex > newCommitCount - 1` after each push
- **multi-commit Change-Id continuity**: on retry cycles, `perRepoChangeIds` now carries ALL commit indices per repo (single-commit repos get a flat string for backward compat; multi-commit repos get `{ "0": "I...", "1": "I..." }`). The agent-worker `resolveExistingChangeId()` looks up per-index entries so every commit reuses its prior Gerrit Change-Id
- **multi-commit workspace restoration**: `checkoutPriorPatchset()` checks out commit 0 via `applyGerritPatchset`, then cherry-picks commits 1..N in order via `cherryPickGerritPatchset`
- concurrency gating is applied around code-generation cycles and review workspace/agent execution (not during ticket polling/task creation), keyed by `agents.integrationId` and limited by `agents.maxConcurrent`; acquisition returns an opaque single-use lease that captures the exact project, agent, and integration counters to release even if setup fails or the agent configuration changes while work is running, while review recovery queues until a slot is released
- an agent-reported failed cycle records `RETRY_CYCLE`, then destroys its workspace and releases its concurrency slot before invoking the next cycle; this prevents same-task container/volume-name collisions and nested slot consumption
- each new code-generation attempt claims `AGENT_RUNNING`, then atomically allocates and persists its explicit `running` cycle through `startAgentCycle`; preparation/push exceptions and task cancellation replace that same row with a failed result carrying the error reason
- every workspace attempt receives a unique Docker container + named-volume name; stale cleanup from an earlier attempt cannot collide with a retry
- `AGENT_TIMEOUT_MS` aborts the in-flight agent container process and waits for its termination before workspace/volume cleanup begins
- **review-system identity is per-push-target**: each `VcsConnector` implementation declares `reviewSystemLabel` (`"gerrit"`, `"gitlab"`, or `"github"`) and `buildPushSpec(baseBranch, taskId)` — mixed Gerrit+GitLab+GitHub projects are fully supported; the orchestrator never inspects integration type strings
- **ticket lifecycle transitions** (`transitionToInProgress`, `transitionToInReview`) are delegated to the `TicketConnector` implementation rather than driven from `OrchestratorConfig` status ID fields

## `pollingLoop.ts`

Every tick (`POLLING_INTERVAL_MS`, exponential backoff on repeated failures) runs **both ticket polling and review polling** concurrently via `Promise.all`:

### `pollProjectTickets()` (project mode only)

- iterates enabled coding projects
- resolves each project's ticket source through the `issue_tracking` binding in `project_integration_bindings`
- fetches assigned tickets via either `pluginManager.getConnectorForCapability(...)` or `pluginManager.createConnectorForCapability(..., { ticketProjectKey })` when the project owns the provider binding
- applies retry gates before calling `startTaskForProject()`
- skips a ticket whose project-scoped task is terminal (non-`FAILED`); when the project-scoped lookup misses, a `getLatestTaskByTicketSource(ticketId, integrationId, ticketProjectKey)` fallback also skips **orphaned** completed tasks (owning project deleted → `project_id` NULL, never re-adopted) so a fresh instance does not re-run finished work
- does **not** pre-defer on concurrency; concurrency is enforced later in `runAgentCycle()` to limit only active agent runs

### `pollReviewProjects()` (project mode + review trigger only)

- iterates enabled **review** projects and reads their review config
- skips integrations whose descriptor declares `streamEvents` (e.g. Gerrit — those receive review assignments via the persistent SSH stream instead)
- calls the code_review connector's `getOpenReviewAssignments(repos)` and fires the `ReviewAssignmentTrigger` (`triggerReview(integrationId, changeId)`) for each new discovery
- wired from `src/index.ts` via `setReviewTrigger()`; a no-op when no trigger is set

### `pollInReviewTasks()` (always on)

- re-checks active code-gen tasks stuck in `IN_REVIEW` (with a non-null external change id) by calling `orchestrator.handleReviewEvent(changeId)` — the polling equivalent of the Gerrit stream-events trigger for GitHub / GitLab integrations

### `pollReviewWatchingTasks()` (always on)

- polling fallback for code-review tasks in `REVIEW_WATCHING`: calls `orchestrator.checkReviewWatchingTask(taskId)` to compensate for missed `change-merged` stream events

All review-side polls share a per-change **cooldown map** (`reviewPollCooldowns`, keyed by change id or `integrationId:changeId`) so a given change is queried at most once per polling interval; stale entries are evicted when tasks leave `IN_REVIEW`.

## `concurrencyTracker.ts`

- `ConcurrencyTracker` gates active `runAgentCycle()` executions (the Docker-heavy phase), keyed by `agents.integrationId` and limited by `agents.maxConcurrent` plus the global `app_concurrency` cap
- it does **not** gate `PollingLoop` or `startTaskForProject`; slots are acquired at cycle start and released at cycle end
- `acquire()` returns an opaque lease (or `null` at capacity), and `release()` consumes that exact lease once. `acquireWhenAvailable()` adds an abortable FIFO wait whose drain remains stable when a just-selected waiter cancels. Releases never re-read mutable agent configuration, so overlapping cycles and integration reassignment cannot decrement the wrong integration counter.

## `feedbackProcessor.ts`

- `extractNewFeedback()` filters out comments/notes already recorded in `processed_comments`
- `isCiFeedbackComment()` recognizes GitHub check-run and Gerrit build-failure IDs so the orchestrator can apply the per-project CI retry setting before deduplication
- `markProcessed()` persists processed IDs once feedback has been consumed
- used on the `IN_REVIEW → FEEDBACK_PROCESSING` path

## Runtime wiring

`src/index.ts` creates the orchestrator once, then refreshes its runtime dependencies in place through `refreshRuntimeDependencies()` when integrations change. This updates connectors, VCS behavior, and admin-facing runtime summaries without restarting the process.

After the admin server binds successfully, `runtimeStartup.ts` enforces startup order: recover active reviews, resume code-generation tasks, run one best-effort workspace reconciliation, then start periodic reconciliation. Its lifecycle handle stops the reconciler idempotently during shutdown.

## Configuration dependencies

The module depends only on:

- `MAX_AGENT_CYCLES`
- `MAX_RETRY_ATTEMPTS`
- `AGENT_TIMEOUT_MS`
- `gitAuthorName` / `gitAuthorEmail` (resolved from the active review integration's config at startup)
- `agentContainerImage`

All provider-specific credentials (SSH keys, GitLab tokens, Redmine URLs, status IDs) are owned by the connector implementations. All clone URLs and target branches are resolved from `project_push_targets`.

## Tests

- `tests/unit/orchestrator.test.ts`
- `tests/unit/orchestrator.projectMode.test.ts`
- `tests/unit/orchestrator.webhookEntryPoints.test.ts`
- `tests/unit/orchestrator.concurrency.test.ts`
- `tests/unit/orchestratorCommitMessage.test.ts`
- `tests/unit/reviewOrchestrator.test.ts`
- `tests/unit/reviewRecovery.test.ts`
- `tests/unit/pollingLoop.projects.test.ts`
- `tests/unit/pollingLoop.concurrency.test.ts`
- `tests/unit/pollingLoop.reviewPolling.test.ts`
- `tests/unit/concurrencyTracker.test.ts`
- `tests/unit/taskLifecycleCoordinator.test.ts`
- `tests/unit/feedbackProcessor.test.ts`

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [state-machine.md](../state-machine.md) — states, transitions, side effects
- [agents.md](agents.md) — agent adapters and the in-container worker
- [vcs.md](vcs.md) — host-side push layer
- [plugins.md](plugins.md) — descriptor registry and PluginManager
- [testing.md](../testing.md) — test layout and conventions
