# Virtual Engineer — Architecture

Virtual Engineer is a host-side Node.js orchestrator with two runtime flows:

- **Ticket-driven code generation**: poll enabled coding projects for assigned work, run an agent cycle in a hardened, ephemeral Docker container, then push the resulting review objects through the host VCS layer.
- **VE-as-reviewer**: accept review events (webhook, Gerrit stream-event, or review-assignment poll), create `code-review` tasks, and run the agent in the same hardened Docker container with `REVIEW_MODE=1` against the patchset diff.

The orchestrator always runs **on the host**. Agent containers are **ephemeral** and are destroyed after each cycle. The pluggable agent engine is **Copilot**, **Claude**, **Aider**, or **Mock**.

## High-level flows

### Code generation

```text
ticket source integration
   → PollingLoop.pollProjectTickets()
   → Orchestrator.startTaskForProject()
   → WorkspaceRunner.clone + post-clone hook
   → CopilotAdapter / ClaudeAdapter / AiderAdapter / MockAgentAdapter
   → agent-worker (node /agent-worker/dist/index.js) in Docker
   → AgentResult (+ optional commit chain)
   → host-side VCS push
   → Gerrit / GitLab / GitHub review
   → webhook feedback back into Orchestrator
```

### Code review

```text
review-system webhook / Gerrit stream-event / review-assignment poll
   → /webhooks/:integrationId/:event (or stream listener / PollingLoop.pollReviewProjects())
   → buildReviewTrigger()
   → ReviewOrchestrator.startReviewTask()
   → workspaceRunner.runReviewInDocker() (agent container, REVIEW_MODE=1)
   → Review provider posts comments / vote
   → REVIEW_WATCHING / REVIEW_DONE / REVIEW_FAILED
```

Review routing is integration-scoped end to end: `buildReviewTrigger()` resolves
the exact active review integration from the webhook `integrationId`, falling
back only to active `review` integrations whose descriptor declares
`createReviewer()`, and review tasks persist `ticketSourceLabel = <type>:<integrationId>`
with integration-scoped `ticketId`s so multiple active review-provider rows
cannot collide on the same change number.

## Layers

### Polling — `src/orchestrator/pollingLoop.ts`

Ticket polling is **project-aware**. The loop iterates enabled coding projects, resolves each project's ticket source via the `issue_tracking` binding in `project_integration_bindings`, fetches assigned tickets through the linked integration, and calls `Orchestrator.startTaskForProject()`. Each tick also runs review-side polling: `pollReviewProjects()` discovers open PR/MR review assignments for enabled review projects (skipped for stream-events integrations such as Gerrit), `pollInReviewTasks()` re-checks `IN_REVIEW` code-gen tasks for new feedback, and `pollReviewWatchingTasks()` re-checks `REVIEW_WATCHING` review tasks for merged/abandoned outcomes. See [modules/orchestrator.md](modules/orchestrator.md).

### Code-gen orchestrator — `src/orchestrator/orchestrator.ts`

Owns the ticket-driven lifecycle. Key public entry points:

- `startTaskForProject(...)`
- `resumeActiveTasks()` for non-terminal code-gen tasks
- `handleReviewEvent(changeId)`
- webhook-facing helpers `triggerFeedbackForChange()`, `markChangeMerged()`, `markChangeAbandoned()`

It builds `TaskContext`, launches agent cycles, persists agent output, manages retry semantics, and delegates push operations to `src/vcs/`.

### Review runtime — `src/review/`

- `reviewOrchestrator.ts` drives `REVIEW_PENDING → ... → REVIEW_DONE/REVIEW_FAILED`; the agent runs in the workspace container via `workspaceRunner.runReviewInDocker()` (`REVIEW_MODE=1`, prompt read from `USER_PROMPT_FILE`)
- `reviewPromptBuilder.ts` and `reviewResultParser.ts` build/parse the review prompt contract

`src/index.ts` wires the Docker review path through `buildReviewBundle()` / `buildReviewTrigger()`, resolving the active review integration's `createReviewer()` descriptor hook.

### State — `src/state/`

- `stateMachine.ts` — pure transition map
- `stateStore.ts` — typed SQLite store and index/bootstrap helper
- `schema.ts` — `tasks`, `state_transitions`, `agent_cycles`, `processed_comments`, `posted_review_comments`, `review_thread_replies`, `integrations`, `oauth_apps`, `gitlab_oauth_apps`, `prompts`, `change_per_repository`, `agents`, `projects`, `project_integration_bindings`, `project_push_targets`, `app_concurrency`
- `migrate.ts` — migration runner

The former `project_ticket_source` / `project_review_integration` / `project_review_repos` tables were **dropped** and replaced by `project_integration_bindings` (one row per `(project_id, capability)` with `capability ∈ issue_tracking | code_review | source_control | agent_execution`; `config_json` shapes: issue_tracking = `{ ticketProjectKey }`, code_review = `{ repos }`). Push targets stay in the dedicated `project_push_targets` table.

See [state-machine.md](state-machine.md) and [database.md](database.md).

### Agents — `src/agents/`

- `copilotAdapter.ts` builds the hardened container spec (Copilot engine)
- `claudeAdapter.ts` builds the container spec for the Claude Code engine (`AGENT_PROVIDER=claude`)
- `aiderAdapter.ts` builds the container spec for the Aider engine (`AGENT_PROVIDER=aider`, wraps any litellm backend)
- `copilotOAuthService.ts` / `copilotModelsService.ts` / `copilotConnectionValidator.ts` handle GitHub OAuth Device Flow, model discovery, and `POST /api/admin/integrations/test`
- `claudeConnectionValidator.ts` / `claudeModelsService.ts` provide the Claude equivalents; `aiderConnectionValidator.ts` / `aiderModelsService.ts` provide the Aider equivalents; `providerAuthService.ts` is the shared auth surface
- `mockAgentAdapter.ts` provides deterministic test behavior
- `cycleCost.ts` derives per-cycle cost from `assistant.usage` events
- `agentEventTypes.ts` normalizes persisted `AgentLogEvent` frames; `agentEventBus.ts` is the shared event bus for live agent log streaming

See [modules/agents.md](modules/agents.md).

### Connectors — `src/connectors/`

Provider-facing clients selected through the plugin system.

- Ticketing: `redmineConnector.ts`, `gitlabIssueConnector.ts`
- Shared infrastructure: `baseTicketConnector.ts`, `gerritSshClient.ts`, `gitlabHttpClient.ts`
- Review / review-discovery: `gerritConnector.ts`, `integrationStreamEvents.ts`, `gerritStreamEvents.ts`, `gerritSshReviewProvider.ts`, `gitlabMergeRequestConnector.ts`

See [modules/connectors.md](modules/connectors.md).

### VCS — `src/vcs/`

Host-side push layer.

- `gerritVcsConnector.ts` pushes to Gerrit
- `gitlabVcsConnector.ts` pushes branches / MRs to GitLab
- `vcsFactory.ts` resolves the connector from the active integration/runtime selection

The agent may create local commits, but the host still owns the final push orchestration and review-system credentials.

### Plugin system — `src/plugins/`

Static descriptor registry plus DB-backed `PluginManager`. `src/index.ts` registers concrete factories and testers, loads enabled integrations, and hot-refreshes runtime dependencies after admin mutations. Startup credential migration encrypts raw and legacy `plain:` password fields with AES-256-GCM; it fails closed when stored credentials exist but `ADMIN_AUTH_SECRET` is absent.

See [modules/plugins.md](modules/plugins.md).

### Admin server — `src/admin/`

Serves the dashboard and auth-protected admin API for integrations, prompts, agents, projects, concurrency, task control, and webhook-secret management. Public webhook routes remain for Redmine / GitLab when webhook dependencies are provided; stream-capable review integrations surface live stream state in the dashboard, with Gerrit currently consuming host-side SSH `stream-events` listeners.

See [modules/admin.md](modules/admin.md).

### Workspace — `src/workspace/`

- `dockerVolume.ts` manages the Docker **named-volume** lifecycle (`/workspace` repo volume + `/ve-home` agent-HOME volume) and `execInVolume()` for helper-container operations.
- `workspaceRunner.ts` clones each project push target into the `/workspace` volume via a helper container, installs any project remote skill sources into `/ve-home`, then spawns the ephemeral agent container and, on exit, destroys the container and volumes. Push operations run in helper containers against the volume; the host retains review-system credentials and push orchestration.
- `skillSources.ts` parses external skill sources and builds the `npx skills` install arguments.
- `dockerVolume.ts` opens SSH key, public-key, and known-hosts files with no-follow semantics, checks the opened regular-file descriptor and approved-root containment, then reads from that same descriptor. Configured paths are confined to orchestrator secret directories. Runtime-generated key material lives in one process-private `0700` temporary directory and is accepted only when its exact path was registered by `sshKeyResolver`; filename patterns do not grant trust.

## Container hardening

`buildContainerSpec()` / `buildReviewContainerSpec()` in [src/agents/copilotAdapter.ts](../../src/agents/copilotAdapter.ts)
set: `--read-only` rootfs, `--cap-drop ALL`, `--security-opt no-new-privileges:true`,
`--tmpfs /tmp:rw,nosuid,size=256m`, a `/workspace` named-volume mount, a `/ve-home`
named-volume mount for the agent HOME, an optional `/ve-prompts` mount, and
`networkMode=virtual-engineer_ve-agent-net`. Push credentials, database
credentials, and admin secrets never reach the container; SSH sockets and
private-key paths stay in short-lived helper containers only.

## Provider selection rules

- Enabled DB integrations win over env-only fallbacks.
- Multiple integrations of the same **provider** may be active simultaneously.
- `PluginManager.loadFromDatabase()` instantiates every enabled integration row and keeps it addressable by `integrationId`.
- Runtime routing must resolve connectors by `integrationId`, capability, or explicit integration lists, not by assuming a single active provider.
- Project-mode routing uses `pluginManager.getConnectorForIntegration(integrationId)`.
- Review-mode webhook routing also resolves the exact Gerrit integration by `integrationId`; code-review tasks must retain that integration in `ticketSourceLabel` so resume/retry paths reopen the correct provider.

## Logging

Pino, module-scoped via `getLogger(...)`. Pretty in development, JSON in production, silent by default in tests.

## Deployment

- Orchestrator: long-running host Node process (`npm run dev`, systemd, PM2, or containerized orchestrator image)
- Agent runtime: per-cycle Docker container from [Dockerfile.agent](../../Dockerfile.agent)
- Optional [scripts/start.sh](../../scripts/start.sh) containerises the orchestrator (host networking); it also creates the `virtual-engineer_ve-agent-net` bridge network used by agent containers

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [state-machine.md](state-machine.md) — states and transitions
- [database.md](database.md) — SQLite schema
- [configuration.md](configuration.md) — env vars
- [modules/orchestrator.md](modules/orchestrator.md) — orchestrator deep-dive
- [modules/agents.md](modules/agents.md) — agent adapters deep-dive
- [modules/connectors.md](modules/connectors.md) — connectors deep-dive
- [modules/vcs.md](modules/vcs.md) — VCS push layer deep-dive
- [modules/plugins.md](modules/plugins.md) — plugin system deep-dive
- [modules/admin.md](modules/admin.md) — admin server deep-dive
