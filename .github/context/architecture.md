# Virtual Engineer — Architecture

Virtual Engineer is a host-side Node.js orchestrator with two runtime flows:

- **Ticket-driven code generation**: poll enabled coding projects for assigned work, run an agent cycle in an ephemeral **OpenShell sandbox**, then push the resulting review objects through the host VCS layer.
- **VE-as-reviewer**: accept review events (webhook, Gerrit stream-event, or review-assignment poll), create `code-review` tasks, and run the agent in the same sandbox with `REVIEW_MODE=1` against the patchset diff.

The orchestrator always runs **on the host**. Sandboxes are **ephemeral** and are destroyed after each cycle, together with the host scratch workspace. The pluggable agent engine is **Copilot**, **Claude**, **Aider**, **Goose**, or **Mock**.

## High-level flows

### Code generation

```text
ticket source integration
   → PollingLoop.pollProjectTickets()
   → Orchestrator.startTaskForProject()
   → OpenShellWorkspaceRunner: host clone (HostGitExecutor) → sandbox create
     → upload → post-clone hook (in sandbox) → exec → download
   → CopilotAdapter / ClaudeAdapter / AiderAdapter / GooseAdapter / MockAgentAdapter
   → agent-worker (node /app/agent-worker/dist/index.js) in the sandbox
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
   → workspaceRunner.runReviewInDocker() (OpenShell sandbox, REVIEW_MODE=1)
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

`src/orchestrator/reviewProgressService.ts` owns code-generation review polling after a push: single/multi-repository convergence, feedback aggregation, CI-failure policy, retry dispatch, and comment resolution. `Orchestrator` supplies narrow lifecycle and connector callbacks and retains the state-machine side effects.

### Review runtime — `src/review/`

- `reviewOrchestrator.ts` drives `REVIEW_PENDING → ... → REVIEW_DONE/REVIEW_FAILED`; the agent runs in the OpenShell sandbox via `workspaceRunner.runReviewInDocker()` (name retained for compatibility; `REVIEW_MODE=1`, prompt read from `USER_PROMPT_FILE`). The repository is uploaded but never downloaded back, so review edits are discarded.
- `reviewPromptBuilder.ts` assembles task context and editable instructions; `reviewOutputContract.ts` owns the immutable Gerrit/GitHub/GitLab JSON contracts; `reviewResultParser.ts` parses and normalizes them
- Review system/instructions prompts are resolved per task from the project override or its assigned agent. Both references are mandatory and must resolve; review integrations provide no prompt fallback.

`src/index.ts` wires the sandbox review path through `buildReviewBundle()` / `buildReviewTrigger()`, resolving the active review integration's `createReviewer()` descriptor hook.

### State — `src/state/`

- `src/domain/identifiers.ts` — branded task, ticket, change, agent, and project identifiers with maker functions
- `src/domain/tasks.ts` — task state constants/types plus persisted task, per-repository change, and transition contracts
- `stateMachine.ts` — pure transition map
- `stateStore.ts` — typed SQLite store facade and domain-store composition
- `schema.ts` — `tasks`, `state_transitions`, `agent_cycles`, `processed_comments`, `posted_review_comments`, `review_thread_replies`, `integrations`, `oauth_apps`, `gitlab_oauth_apps`, `prompts`, `change_per_repository`, `agents`, `projects`, `project_integration_bindings`, `project_push_targets`, `app_concurrency`
- `databaseMigrations.ts` — canonical tracked migration runner plus frozen pre-ledger adoption bridge
- `migrate.ts` — explicit migration CLI entry; startup delegates to the same runner

The former `project_ticket_source` / `project_review_integration` / `project_review_repos` tables were **dropped** and replaced by `project_integration_bindings` (one row per `(project_id, capability)` with `capability ∈ issue_tracking | code_review | source_control | agent_execution`; `config_json` shapes: issue_tracking = `{ ticketProjectKey }`, code_review = `{ repos }`). Push targets stay in the dedicated `project_push_targets` table.

See [state-machine.md](state-machine.md) and [database.md](database.md).

`src/interfaces.ts` remains the compatibility facade for domain exports while new state/orchestrator code can depend directly on the narrower domain modules.

### Agents — `src/agents/`

- `containerSpecBuilders.ts` owns the shared sandbox spec (`buildCodegenContainerSpec` / `buildReviewContainerSpec`); adapters supply only provider-specific env deltas and their egress spec
- `copilotAdapter.ts` builds the sandbox spec for the Copilot engine
- `claudeAdapter.ts` builds the container spec for the Claude Code engine (`AGENT_PROVIDER=claude`)
- `aiderAdapter.ts` builds the container spec for the Aider engine (`AGENT_PROVIDER=aider`, wraps any litellm backend)
- `gooseAdapter.ts` builds the container spec for the Goose engine (`AGENT_PROVIDER=goose`, MCP submission transport like Copilot/Claude)
- `copilotOAuthService.ts` / `copilotModelsService.ts` / `copilotConnectionValidator.ts` handle GitHub OAuth Device Flow, model discovery, and `POST /api/admin/integrations/test`
- `claudeConnectionValidator.ts` / `claudeModelsService.ts` provide the Claude equivalents; `aiderConnectionValidator.ts` / `aiderModelsService.ts` provide the Aider equivalents; `gooseConnectionValidator.ts` / `gooseModelsService.ts` provide the Goose equivalents; `providerAuthService.ts` is the shared auth surface
- `mockAgentAdapter.ts` provides deterministic test behavior
- `cycleCost.ts` derives per-cycle cost from `assistant.usage` events
- `agentEventTypes.ts` normalizes persisted `AgentLogEvent` frames; `agentEventBus.ts` is the shared event bus for live agent log streaming

See [modules/agents.md](modules/agents.md).

### Connectors — `src/connectors/`

Provider-facing clients selected through the plugin system.

- Ticketing: `redmineConnector.ts`, `gitlabIssueConnector.ts`, `githubIssueConnector.ts`
- Shared infrastructure: `baseTicketConnector.ts`, `gerritSshClient.ts`, `gitlabHttpClient.ts`
- Review / review-discovery: `gerritConnector.ts`, `integrationStreamEvents.ts`, `gerritStreamEvents.ts`, `gerritSshReviewProvider.ts`, `gitlabMergeRequestConnector.ts`, `githubPullRequestReviewConnector.ts`, `githubReviewProvider.ts`

See [modules/connectors.md](modules/connectors.md).

### VCS — `src/vcs/`

Host-side push layer.

- `gerritVcsConnector.ts` pushes to Gerrit
- `gitlabVcsConnector.ts` pushes branches / MRs to GitLab
- `nodeGitRunner.ts` executes every connector git command via `execFile` (no shell), hardened with `trustedGitArgs` / `trustedGitEnv` from `src/utils/gitExec.ts`
- `vcsFactory.ts` resolves the connector from the active integration/runtime selection

The agent may create local commits, but the host still owns the final push orchestration and review-system credentials. Push runs directly on the host workspace directory — there is no credential-bearing helper container.

### Plugin system — `src/plugins/`

Static descriptor registry plus DB-backed `PluginManager`. `src/index.ts` registers the built-in descriptors, supplies shared `AgentAdapterContext`, loads enabled integrations, and hot-refreshes runtime dependencies after admin mutations. Concrete connector, reviewer, adapter, and connection-test factories live on provider descriptors; explicit `PluginManager` override hooks remain available for tests and embedders. Startup credential migration encrypts raw and legacy `plain:` password fields with AES-256-GCM; it fails closed when stored credentials exist but `ADMIN_AUTH_SECRET` is absent. Historical unprefixed AES-GCM detection applies only to `sessionToken` and `sshPrivateKeyEnc`, avoiding collisions with valid base64 provider credentials.

See [modules/plugins.md](modules/plugins.md).

### Admin server — `src/admin/`

Serves the dashboard and auth-protected admin API for integrations, prompts, agents, projects, concurrency, task control, and webhook-secret management. Public webhook routes remain for Redmine / GitLab when webhook dependencies are provided; stream-capable review integrations surface live stream state in the dashboard, with Gerrit currently consuming host-side SSH `stream-events` listeners.

See [modules/admin.md](modules/admin.md).

### Workspace — `src/workspace/`

- `openShellWorkspaceRunner.ts` is the **sole** `WorkspaceRunner`. Per cycle it creates a uniquely named sandbox (`ve-<taskId>-<rand>`), applies the resolved runtime policy, opens the adapter's declared egress, uploads the host workspace (including `.git`, `noGitIgnore: true`) to `/sandbox`, runs the optional post-clone script **inside** the sandbox, execs the agent, downloads the repo back for the coding flow, then destroys sandbox, temporary credential provider, and host directory. Review runs upload only — nothing is downloaded back.
- `hostGitExecutor.ts` owns all host-side git plumbing (create workspace, clone, fetch/checkout, cherry-pick, `execGit`, trusted-metadata rebuild, destroy). Every invocation goes through `trustedGitArgs` / `trustedGitEnv`.
- After download, `restoreTrustedRemotes()` rebuilds `.git` metadata from host-recorded, credential-free remotes; `listTrustedRepoPaths()` reports the sub-paths VE itself cloned, and `Orchestrator.pushProjectChanges()` refuses to run git in any other directory.
- `skillSources.ts` parses `projects.skill_sources_json`, builds `npx skills` arguments, and exports the shared SSH/env-building helpers used by both admin-side discovery and the host-side installer (`skillSourceInstaller.ts`) — see "External skill sources" below.
- Remaining files are discovery-side and unrelated to agent execution: `workspaceScanService.ts`, `workspaceManifestScanner.ts`, `repositoryManifestAccess.ts`, `integrationBindingResolver.ts`, `agentWorkerProtocol.ts`.

### External skill sources

`projects.skill_sources_json` is persisted, editable in the admin UI, and forwarded onto `AgentSession.skillSourcesJson` (`src/orchestrator/agentContextBuilder.ts`, `src/review/reviewOrchestrator.ts`). `OpenShellWorkspaceRunner` calls `skillSourceInstaller.ts`'s `installSkillSources()` on the **host**, after checkout and before upload, so the fetched skill files ride along with the ordinary workspace upload while SSH material never reaches the sandbox. Supported providers (Copilot, Claude, Goose) install into their native project-relative skill directory; Aider/Mock are skipped. See [modules/workspace.md](modules/workspace.md#external-skill-sources) for the full flow.

## Sandbox hardening

Isolation comes from **OpenShell runtime policies**, not from Docker flags. `buildCodegenContainerSpec()` / `buildReviewContainerSpec()` in [src/agents/containerSpecBuilders.ts](../../src/agents/containerSpecBuilders.ts) return only:

```ts
{ image, env, command, userPromptContent?, egress? }
```

There is no `networkMode`, no `additionalDockerArgs`, and no `--read-only` / `--cap-drop` / `--security-opt` / `--tmpfs`. `command` is always `["node", "/app/agent-worker/dist/index.js"]`.

- Base policy: `buildDefaultPolicyYaml()` ([src/openshell/openShellPolicyBuilder.ts](../../src/openshell/openShellPolicyBuilder.ts)) — `version: 1`, `filesystem_policy.read_only = [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log]`, `filesystem_policy.read_write = [/sandbox, /tmp, /dev/null]`, `landlock.compatibility: best_effort`, `process.run_as_user/run_as_group = sandbox`. Network is deny-by-default (no `network_policies` section = no egress).
- Per-project / per-agent overrides compose through [src/openshell/runtimePolicyResolver.ts](../../src/openshell/runtimePolicyResolver.ts); after composition `enforceSandboxFloor()` re-asserts `process.run_as_user/group = sandbox` and rejects a `read_write` entry naming `/`, `/usr`, `/lib`, `/etc`, `/app`, `/bin`, `/sbin`, `/boot`, or `/var`.
- Egress is opened explicitly per run via `OpenShellClient.allowEgress({ hosts, binaries })` from the adapter's `AgentEgressSpec` (`COPILOT_EGRESS` / `CLAUDE_EGRESS` / `src/agents/backendEgress.ts`).
- Sandbox paths: repository at `/sandbox/<basename(workspaceDir)>` (the exec `workdir`), prompt at `/tmp/user-prompt.txt`, worker runtime at `/app/agent-worker/`, MCP submission artifact at `/tmp/ve-agent-submission.json`. `/workspace` and `/ve-home` no longer exist.
- Agent credentials never reach argv: `splitManagedProviderEnv()` moves each known credential env var into a short-lived attached OpenShell provider and fails closed on an unmapped `TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|CREDENTIAL` name. Push credentials, database credentials, and admin secrets never enter the sandbox.
- Policy denials are harvested best-effort after every attempt by `collectPolicyDenials()` — `OpenShellClient.getSandboxLogs()` parsed through [src/openshell/denialEvents.ts](../../src/openshell/denialEvents.ts) (`parseDenialEvent`, `scrubSecrets`), deduplicated per sandbox by line fingerprint.

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
- Agent runtime: per-cycle OpenShell sandbox from the image built by [Dockerfile.agent](../../Dockerfile.agent) (`AGENT_CONTAINER_IMAGE`, default `virtual-engineer-workspace:latest`); the image must contain a `sandbox` user/group whose home is `/sandbox`
- Optional [scripts/start.sh](../../scripts/start.sh) containerises the orchestrator and brings up the OpenShell gateway. `OPENSHELL_COMPUTE_DRIVER` defaults to `docker` (gateway-owned `openshell-docker` bridge); `kubernetes` (k3s/Helm) is experimental. Docker appears only as the gateway's compute driver — VE never runs `docker run` for an agent.

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
