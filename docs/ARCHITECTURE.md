# Virtual Engineer — Architecture

---

## 1. System overview

Virtual Engineer is a **Node.js orchestrator** that runs on the host (or in a Docker container) and drives two autonomous workflows:

- **Code generation** — picks up tickets, clones the repo into an ephemeral Docker container, lets Copilot implement the changes, then pushes for review.
- **Code review** — receives review events (Gerrit SSH stream, GitLab/GitHub webhooks, or polling), runs Copilot on the diff inside a Docker container, and posts inline comments + a vote.

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  HOST PROCESS  (Node.js orchestrator, src/index.ts)                      │
  │                                                                          │
  │  ┌────────────────┐  poll 30s   ┌───────────────────────────────────┐   │
  │  │  Ticket System │◄────────────│  PollingLoop                      │   │
  │  │  Redmine /     │             └──────────────┬────────────────────┘   │
  │  │  GitLab/GitHub │                            │ startTaskForProject    │
  │  │  Issues        │                            ▼                        │
  │  └────────────────┘            ┌───────────────────────────────────┐   │
  │  ┌────────────────┐  SSH/HTTP  │  Orchestrator                     │   │
  │  │  Review System │◄───────────│  runWorkflow / state machine      │   │
  │  │  Gerrit /      │            └──────────────┬────────────────────┘   │
  │  │  GitLab MR /   │                            │                        │
  │  │  GitHub PR     │                            ▼                        │
  │  └────────────────┘                            ▼                        │
  │                                ┌───────────────────────────────────┐   │
  │                                │  StateStore  (SQLite WAL)         │   │
  │                                └──────────────┬────────────────────┘   │
  │                                               │                        │
  │                                ┌──────────────▼────────────────────┐   │
  │                                │  WorkspaceRunner                  │   │
  │                                │  1. docker volume create (×2)     │   │
  │                                │  2. git clone (helper container)  │   │
  │                                │  3. docker run  (agent container) │   │
  │                                │  4. git commit + push (helper)    │   │
  │                                │  5. docker volume rm  (×2)        │   │
  │                                └──────────────┬────────────────────┘   │
  └──────────────────────────────────────────────-┼────────────────────────┘
                git push SSH / HTTP                │ docker run --rm
                        ▼                          ▼
  ┌──────────────────────────┐   ┌─────────────────────────────────────────┐
  │  Gerrit / GitLab         │   │  Ephemeral Agent Container              │
  └──────────────────────────┘   │  virtual-engineer-workspace:latest      │
                                 │  /workspace  → named volume (repo)      │
                                 │  /ve-home    → named volume (CLI home)  │
                                 │                                         │
                                 │  node /agent-worker/dist/index.js      │
                                 │    → copilot --headless                 │
                                 │    → edits files, git commit            │
                                 │    → AgentResult JSON → stdout          │
                                 │  (no push credentials inside)           │
                                 └─────────────────────────────────────────┘
```

**Key design decisions:**

- The host owns all credentials (SSH keys, API tokens). The agent container receives only a GitHub token for the Copilot LLM call.
- Workspaces use Docker **named volumes** — not host-path bind mounts — so the orchestrator can itself run inside Docker without path-mapping issues.
- Multiple integrations of the same type (e.g. two Gerrit servers) can be active simultaneously; runtime routing is by `integrationId`, not type.

---

## 2. Source layout

```
src/
  index.ts              # Process entry — boots admin server, plugins, orchestrator
  config.ts             # Zod-validated AppConfig (loads .env)
  interfaces.ts         # Branded IDs, TaskState, all shared interfaces
  copilotModel.ts       # Default Copilot model constant
  logger.ts             # Pino logger factory (silent in test)

  admin/                # HTTP admin server + React SPA dashboard
    adminServer.ts        # Thin route multiplexer, auth, security headers
    router.ts             # Route-module dispatch table
    adminRouteUtils.ts    # Shared HTTP primitives (writeJson, readBody, etc.)
    adminTaskRoutes.ts    # /api/admin/tasks CRUD + actions
    adminPromptRoutes.ts  # /api/admin/prompts CRUD
    adminStreamRoutes.ts  # SSE endpoints (logs/stream, events/stream)
    adminIntegrationRoutes.ts # /api/admin/integrations + plugins + oauth-apps
    adminAgentsRoutes.ts  # /api/admin/agents CRUD + plugin OAuth
    adminProjectsRoutes.ts# /api/admin/projects CRUD
    adminConcurrencyRoutes.ts # /api/admin/concurrency
    adminSettingsRoutes.ts# /api/admin/settings (editable runtime workflow settings)
    adminWebhookRoutes.ts # Webhook secret rotation, allowed-IPs, info
    adminOverviewRoutes.ts# Dashboard overview + cost-summary endpoints
    dashboard.ts          # Serves the Vite-built React SPA from dist/admin-ui
    ui/                   # React SPA source (App.tsx, views/, components/,
                          # shell/, theme/, icons/, api.ts, states.ts)
    assets/               # Static assets bundled by Vite
    startAdminServer.ts   # net.Server lifecycle wrapper
    closeAdminServer.ts

  agents/               # Agent adapters and event infrastructure
    copilotAdapter.ts     # Builds container spec, parses AgentResult
    copilotConnectionValidator.ts
    copilotModelsService.ts
    copilotOAuthService.ts
    providerAuthService.ts
    claudeAdapter.ts      # Claude Code adapter (agent_execution)
    claudeConnectionValidator.ts
    claudeModelsService.ts
    aiderAdapter.ts       # Aider adapter (agent_execution; wraps any litellm backend)
    aiderConnectionValidator.ts
    aiderModelsService.ts
    cycleCost.ts          # Derives per-cycle cost from assistant.usage events
    mockAgentAdapter.ts   # Deterministic mock, no Copilot needed
    agentEventBus.ts      # SSE event bus for live log streaming
    agentEventTypes.ts

  connectors/           # External system connectors
    baseTicketConnector.ts
    gerritConnector.ts    # Gerrit SSH review API
    gerritSshClient.ts
    gerritSshReviewProvider.ts
    gerritStreamEvents.ts    # Gerrit SSH event stream listener
    githubIssueConnector.ts
    githubPullRequestReviewConnector.ts
    githubReviewProvider.ts
    gitlabHttpClient.ts
    gitlabIssueConnector.ts
    gitlabMergeRequestConnector.ts
    gitlabMergeRequestReviewProvider.ts
    integrationStreamEvents.ts  # Descriptor-driven stream reconciler
    redmineConnector.ts

  orchestrator/
    orchestrator.ts       # Ticket workflow driver (state machine caller)
    pollingLoop.ts        # 30s tick → per-project connector poll
    feedbackProcessor.ts  # Parses review comments into retry context
    concurrencyTracker.ts # integration-scoped in-memory run-slot gates

  plugins/              # Plugin system
    registry.ts           # Static provider → descriptor map
    pluginManager.ts      # DB-driven instance lifecycle
    init.ts               # Registers built-in descriptors at startup
    descriptors/          # One unified descriptor per provider (+ index.ts,
                          # githubOAuth/gitlabOAuth/claudeOAuth helpers;
                          # aider.ts for the Aider agent_execution provider)

  review/               # Code-review workflow
    reviewOrchestrator.ts # REVIEW_PENDING → REVIEW_DONE lifecycle
    reviewPromptBuilder.ts
    reviewResultParser.ts
    commentFilter.ts      # Filters comments to lines present in the diff
    commentHash.ts        # sha1(file + normalized message) dedup key
    commentSeverity.ts    # Severity ranks + volume/severity gate
    revisionPatchset.ts

  state/
    schema.ts             # Drizzle table definitions
    stateMachine.ts       # VALID_TRANSITIONS + validateTransition
    stateStore.ts         # SqliteStateStore facade — all DB access
    stores/               # Domain-scoped DB modules: task, integration,
                          # project, prompt(+seeding), agent(+concurrency),
                          # settings (app_settings singleton)
    migrate.ts            # Runs Drizzle migrations on startup

  utils/
    encryption.ts         # AES-256-GCM token encryption
    errorClassifier.ts
    gitExec.ts
    githubAuth.ts
    gitlabAuth.ts
    opensshKeyFormat.ts
    redactUrl.ts
    sshConfig.ts
    sshKeyGen.ts
    sshKeyResolver.ts
    ticketFooterFormatter.ts
    ticketSourceLabel.ts

  vcs/                  # Repository operations (clone, push, MR/PR creation)
    vcsConnector.ts       # Interface
    gerritVcsConnector.ts # SSH clone + push via helper containers
    gitlabVcsConnector.ts # HTTP clone + push + MR creation
    githubVcsConnector.ts # HTTP clone + push + PR creation
    branchNaming.ts       # Deterministic feature-branch names
    vcsFactory.ts         # createVcsConnectorForIntegration(integration, context?)

  webhooks/             # Inbound webhook receiver
    webhookServer.ts
    handlers/             # redmine, gitlab-issue, gitlab-merge-request,
                          # github-pull-request (HMAC-validated)

  workspace/
    dockerVolume.ts       # createVolume / removeVolume / execInVolume
    workspaceRunner.ts    # DockerWorkspaceRunner — orchestrates clone+run+push

agent-worker/
  src/index.ts          # Provider-agnostic orchestrator INSIDE the agent
                        # container; built to dist/ via tsconfig.agent.json
  src/providers/        # types, events, copilot, claude, aider, registry
                        # (per-provider runners + registry dispatch)
  src/commitUtils.ts
  src/networkGuard.ts
  src/validate-copilot-connection.ts
```

---

## 3. Components

### 3.1 Orchestrator

`src/orchestrator/orchestrator.ts`

Drives the **code-generation task lifecycle**. Each task is a state-machine traversal persisted in SQLite; the orchestrator resumes in-flight tasks after a process restart.

```
  startTaskForProject(ticket, project)
          │
          ▼ (concurrency gate)
    createTask  ──► DETECTED
          │
          ▼
    runWorkflow(task)
          │
    ┌─────▼──────────────────────────────────────┐
    │  DETECTED → CONTEXT_BUILDING               │
    │        → AGENT_RUNNING                     │  ← WorkspaceRunner (clone + run + push)
    │        → IN_REVIEW                         │
    │        → FEEDBACK_PROCESSING               │  ← FeedbackProcessor
    │        → RETRY_CYCLE → AGENT_RUNNING       │  ← next cycle
    │        → MERGED → CLOSING → DONE           │
    │        → FAILED / ABANDONED                │
    └────────────────────────────────────────────┘
```

Project mode injects `ProjectModeDeps` which provides per-project agent resolution, VCS connector, and the `ConcurrencyTracker`. In project mode the orchestrator resolves the agent and VCS connector from the project's bindings — not from global env vars. Ticket selection comes from the project's `project_integration_bindings` issue_tracking binding (`config_json.ticketProjectKey`), and MR/push selection comes from the relevant `project_push_targets.repo_key`.

---

### 3.2 PollingLoop

`src/orchestrator/pollingLoop.ts`

Tick-based polling with exponential backoff on consecutive failures.

```
  setInterval(30s)
       │
       ▼
  pollTickets()
       │
       ▼ (for each enabled coding project)
  connector.getAssignedTickets(project ticket binding)
       │
       ▼ (for each ticket not already in progress)
  orchestrator.startTaskForProject(ticket, project)
```

- Backoff: doubles each failure (capped), resets on success.
- Concurrency: polling discovers eligible work without pre-gating whole projects. `Orchestrator.runAgentCycle()` acquires capacity around the Docker-heavy agent phase; tasks deferred in `CONTEXT_BUILDING` or `RETRY_CYCLE` are re-driven on later ticks.
- Review polling: the same tick also drives `pollInReviewTasks()` (feedback on open changes), `pollReviewWatchingTasks()` (patchset / merge status), and `pollReviewProjects()` (review-assignment discovery via `ReviewAssignmentTrigger`), with per-change review-poll cooldowns.
- Hot-reload: `setProjectMode()` refreshes the project store and plugin manager reference without a restart.

---

### 3.3 WorkspaceRunner

`src/workspace/workspaceRunner.ts` + `src/workspace/dockerVolume.ts`

Manages the **Docker volume lifecycle** for each agent cycle. All VCS operations run inside temporary helper containers so the orchestrator itself never needs git on its PATH.

```
  runCycle(task, project)
       │
       ├─ createVolume("ve-ws-<taskId>-<rand>")   ← repo files
       ├─ createVolume("ve-home-<taskId>-<rand>")  ← Copilot CLI native modules
       │
       ├─ execInVolume(clone helper)   ← git clone via SSH or HTTP
       │
       ├─ runAgentInDocker(adapter, context)
       │     └─ docker run --rm \
       │           --read-only --cap-drop ALL \
       │           --security-opt no-new-privileges:true \
       │           --tmpfs /tmp:rw,nosuid,size=256m \
       │           -v ve-ws:/workspace \
       │           -v ve-home:/ve-home \
       │           virtual-engineer-workspace:latest \
       │           node /agent-worker/dist/index.js
       │
      ├─ worker normalizes commits    ← Change-Ids + configured ticket trailer
      ├─ execInVolume(push helper)    ← push existing HEAD commit chain
       │
       └─ removeVolume(ve-ws) + removeVolume(ve-home)
```

`execInVolume` injects SSH keys via a base64-encoded env var (decoded inside the helper and written to `/tmp/ssh-key`) to avoid host-path bind-mount issues when the orchestrator itself runs in Docker.

The worker validates the commits created during the agent run and injects missing Change-Ids and configured ticket trailers before returning. Project pushes require `VcsConnector.pushDirect()`: the host owns credentials and push orchestration but does not synthesize another commit.

---

### 3.4 Admin Server

`src/admin/adminServer.ts` — thin multiplexer and auth gate.

Plain Node.js `http.createServer` — no framework. The main file handles auth, security headers, and public endpoints (dashboard, health, img-proxy), then dispatches to modular route handlers that each follow the pattern `handleXxxRoute(req, res, path, method, deps): Promise<boolean>`.

**Authentication:** DB-backed session tokens. `POST /api/admin/auth/login` exchanges username/password for an opaque random token (stored as SHA-256 hash in `user_sessions`). Every subsequent request sends `Authorization: Bearer <token>`. Authorization is **pure PBAC**: each route is gated by a declared permission, with `admin` as the only superuser bypass (`operator`/`viewer` grant no access by role — they only select the default policy bundle at user creation). `ADMIN_AUTH_SECRET` is used only to encrypt OAuth tokens stored in the database, not for admin auth.

**Route modules:**

| Module | Route group |
|--------|-------------|
| `adminServer.ts` | Dashboard (`GET /admin`), health (`GET /health`), img-proxy, status, config, providers |
| `adminOverviewRoutes.ts` | Dashboard overview aggregates + cost summary |
| `adminTaskRoutes.ts` | `GET/DELETE /api/admin/tasks`, `GET /api/admin/tasks/:id`, `GET .../cycles`, `GET .../transitions`, `PATCH .../pause`, `PATCH .../resume`, `POST .../retry`, `POST .../abandon` |
| `adminPromptRoutes.ts` | `GET/POST /api/admin/prompts`, `GET/PUT/DELETE /api/admin/prompts/:id`, `GET .../usage` |
| `adminStreamRoutes.ts` | `GET /api/admin/logs/stream` (SSE), `GET /api/admin/events/stream` (SSE) |
| `adminIntegrationRoutes.ts` | `GET/POST /api/admin/integrations`, `GET/PUT/DELETE .../integrations/:id`, `POST .../test`, `PATCH .../{enable,disable}`, `POST .../discover`, `GET .../models`, `GET /api/admin/plugins`, `GET/POST/DELETE /api/admin/oauth-apps` |
| `adminAgentsRoutes.ts` | `GET/POST /api/admin/agents`, `GET/PUT/DELETE .../agents/:id`, `PATCH .../{enable,disable}`, `POST /api/admin/plugins/:type/oauth/*` |
| `adminProjectsRoutes.ts` | `GET/POST /api/admin/projects`, `GET/PUT/DELETE .../projects/:id`, `PATCH .../{enable,disable}` |
| `adminConcurrencyRoutes.ts` | `GET /api/admin/concurrency` (read-only run-slot snapshot) |
| `adminSettingsRoutes.ts` | `GET/PUT /api/admin/settings` (editable runtime workflow settings) |
| `adminWebhookRoutes.ts` | `POST .../webhook-secret/rotate`, `GET/PUT .../webhook-allowed-ips`, `GET .../webhook-info` |

**Shared primitives** (`adminRouteUtils.ts`): `writeJson`, `writeHtml`, `readBody` (512 KB limit), `toIsoTimestamp`, `asRecord`, `SECRET_MASK`.

The dashboard client is a **Vite-built React SPA** (`src/admin/ui/`, served by `dashboard.ts` from `dist/admin-ui` via manifest lookup; build with `npm run build:ui`, watch with `npm run dev:ui`).

Editing an integration calls `onIntegrationUpdated()` which invalidates the VCS connector cache and hot-reloads the plugin manager without a restart.

---

### 3.5 PluginManager

`src/plugins/pluginManager.ts`

Bridges the **static plugin registry** (compile-time descriptors) with the **dynamic database config** (runtime rows).

```
  startup
    │
    ▼
  loadFromDatabase()
    │
    ├─ getIntegrations()  ← reads all enabled rows
    │
    └─ for each integration:
         descriptor(provider) capability factory(configJson) → connector instance
         store in activeInstancesById[id]   (all rows stay active in parallel,
                                             including same-provider duplicates)

  runtime lookup
    getConnectorForIntegration(id)             →  instance by integrationId
    getConnectorForCapability(id, capability)  →  capability-scoped connector
    getActiveIntegrationsByCapability(cap)     →  all active rows exposing a capability
    getActiveIntegrationsByProvider(provider)  →  all active rows of one provider
    providerSupportsCapability(provider, cap)  →  static descriptor check
```

There is no "type-leader" or category concept: routing is always by `integrationId` or by **domain capability** (`issue_tracking`, `code_review`, `source_control`, `agent_execution`). Project-bound connector instances can be built via `createConnectorForIntegration(integrationId, context)` when a VE project owns part of the provider binding.

Enabling/disabling an integration via the admin API calls `enablePlugin` / `disablePlugin`, updates the DB, and refreshes the in-memory maps — no restart needed.

---

### 3.6 CopilotAdapter

`src/agents/copilotAdapter.ts`

Builds the **Docker container spec** and parses the agent result.

```
  execute(context)
       │
       ├─ getGitHubOAuthToken(context)    ← OAuth or direct token from integration
       │
       ├─ buildContainerSpec(context, authEnv)
       │     env: GITHUB_TOKEN, COPILOT_MODEL, task context vars
       │     additionalDockerArgs:
       │       --read-only
       │       --cap-drop ALL
       │       --security-opt no-new-privileges:true
       │       --security-opt label=disable    (SELinux compat)
       │       --tmpfs /tmp:rw,nosuid,size=256m
       │
       ├─ docker run → agent-worker/dist/index.js
       │     stdout: JSON AgentResult
       │     stderr: structured __ve_event lines + plain logs
       │
       └─ parseAgentResult(stdout)
             validate commitMessage against CONVENTIONAL_COMMIT_RE
             fallback to "feat: <subject>" if missing/invalid
```

The agent container is placed on `virtual-engineer_ve-agent-net` — a dedicated Docker bridge network that isolates it from the default bridge and other containers. The network is **not** `--internal`, so the container retains outbound access (required to reach the GitHub/Copilot APIs).

---

#### 3.6.1 ClaudeAdapter

`src/agents/claudeAdapter.ts`

An alternative `agent_execution` adapter that runs Anthropic **Claude Code** via Anthropic's Claude tooling inside the same hardened container. It mirrors `CopilotAdapter` (same security args, `/ve-home` HOME volume, `__ve_event` stderr protocol, commit collection, and `AgentResult` contract) but:

- injects `AGENT_PROVIDER=claude` + `CLAUDE_MODEL` and exactly one auth env var — `ANTHROPIC_API_KEY` (api-key integrations, carried via the generic `apiKey`/`githubToken` field) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription integrations, carried via `encryptedSessionToken`);
- dispatches in the worker: `agent-worker/src/index.ts` resolves the runner via `providers/registry.ts` and calls `providers/claude.ts` `runClaudeAgent()` when `AGENT_PROVIDER=claude`, which drives the SDK `query()` and maps its message stream onto the shared event/commit/result pipeline.

The adapter injects **no** default model: when the agent config leaves the model unset, `CLAUDE_MODEL` is omitted and the Claude CLI picks its own default. Adapters are registered generically — any descriptor that declares `capabilities.agent_execution.buildAdapter` is instantiated by the plugin manager from host runtime context (`AgentAdapterContext`), so `index.ts` special-cases no provider.

Connection methods live on the `claude` descriptor (`src/plugins/descriptors/claude.ts`, `authMode`): `api_key` and `subscription` (interactive authorization-code + PKCE OAuth via `claudeOAuth.ts`). Cost columns stay null (Claude has no AIU); token usage is still emitted.

---

#### 3.6.2 AiderAdapter

`src/agents/aiderAdapter.ts`

An alternative `agent_execution` adapter that runs the [Aider CLI](https://aider.chat) (a Python package wrapping any LLM backend via litellm) inside the same hardened container. It mirrors `CopilotAdapter`/`ClaudeAdapter` (same security args, `/ve-home` HOME volume, `__ve_event` stderr protocol, commit collection, and `AgentResult` contract) but:

- injects `AGENT_PROVIDER=aider` + `AIDER_MODEL` (only when configured) and the selected backend's litellm auth env var(s);
- dispatches in the worker: `agent-worker/src/index.ts` resolves the runner via `providers/registry.ts` and calls `providers/aider.ts` `runAiderAgent()` when `AGENT_PROVIDER=aider`. Coding cycles use `--no-stream --git --auto-commits --dirty-commits --commit-prompt <conventional-commits>`. Review cycles omit `--no-stream` and use `--no-git --chat-mode ask --no-auto-commits --no-dirty-commits`; disabling Git avoids `.git/config.lock` writes in the read-only review workspace.

The adapter injects **no** default model: when the agent config leaves the model unset, `AIDER_MODEL` is omitted and the Aider CLI picks its own default. Six LLM backends are declared on the `aider` descriptor (`src/plugins/descriptors/aider.ts`, `aiderBackend` selector): `openai` → `OPENAI_API_KEY`; `anthropic` → `ANTHROPIC_API_KEY`; `ollama` → `OLLAMA_API_BASE` (no key); `openrouter` → `OPENROUTER_API_KEY`; `deepseek` → `DEEPSEEK_API_KEY`; `openai_compat` → `OPENAI_API_KEY` + `OPENAI_API_BASE`. `orchestrator.resolveProjectAgentRuntime` forwards these from the integration config onto `AgentSession` via `ResolvedAgentConfig.extra`. The Aider CLI is installed in the agent image via `uv tool install aider-chat` (see `Dockerfile.agent`). Cost columns stay null (Aider has no AIU); token usage is still emitted.

---

### 3.7 ReviewOrchestrator

`src/review/reviewOrchestrator.ts`

Drives the **code-review lifecycle** for a single change.

```
  Gerrit patchset-created stream event / GitHub PR / GitLab MR webhook
       │
       ▼
  createReviewTask()  →  REVIEW_PENDING
       │
       ▼
  REVIEW_RUNNING
       │
       ├─ clone repo via execInVolume
       ├─ git fetch refs/changes/<patchset>
       ├─ buildReviewPrompt(diff + "already reported" prior comments)
       │
       ├─ docker run (agent container, REVIEW_MODE=1)
       │     reads USER_PROMPT_FILE (/ve-home/user-prompt.txt)
       │     returns raw LLM text → stdout
       │
       ├─ parseReviewResult(output)  →  comments + vote
       ├─ dedup against posted_review_comments (comment_hash)
       ├─ severity/volume gate (REVIEW_MIN_SEVERITY, MAX_REVIEW_COMMENTS);
       │    excess folded into the summary
       │
       ▼
  REVIEW_COMMENTING
       │
       ├─ reviewer.postReview(comments, summary, vote)   ← Gerrit / GitLab / GitHub
       │
       ▼
  REVIEW_WATCHING  ←──────────────────────────────────────────┐
       │                                                       │
       ├─ new patchset uploaded? ──► REVIEW_RUNNING ──────────┘
       └─ change merged/abandoned? ──► REVIEW_DONE
```

---

### 3.8 VCS Connectors

`src/vcs/`

| Connector | Transport | Push mechanism |
|-----------|-----------|----------------|
| `GerritVcsConnector` | SSH (via helper container) | `git push refs/for/<branch>` + Change-Id footer |
| `GitLabVcsConnector` | HTTP (token in `.git-credentials`) | `git push` + GitLab REST API MR creation |
| `GitHubVcsConnector` | HTTP (token in `.git-credentials`) | `git push` + GitHub REST API PR creation |

Both operate entirely via `execInVolume` — no VCS tools run directly on the orchestrator process. SSH keys are injected as base64 env vars.

`vcsFactory.ts` exports `createVcsConnectorForIntegration(integration, context?)` which reads the integration's `configJson` and returns the appropriate connector.

---

## 4. State machine

Two independent task lifecycles share the same `TaskState` union.

### 4.1 Code-generation flow

```
                         ┌──────────────────────────────┐
                         │                              │
  DETECTED               │                              ▼
     │                   │              FEEDBACK_PROCESSING
     ▼                   │                 │        │
  CONTEXT_BUILDING        │          RETRY_CYCLE  IN_REVIEW ──► MERGED ──► CLOSING ──► DONE
     │                   │                 │          │              │
     ▼                   │                 ▼          │              └──► DONE (direct)
  AGENT_RUNNING ──────────┘          AGENT_RUNNING    │
     │                                    │         ABANDONED
     │                                    │
     └──► IN_REVIEW ─────────────────────►┘
     │
     ├──► FAILED
     └──► ABANDONED
```

### 4.2 Code-review flow

```
  REVIEW_PENDING
       │
       ▼
  REVIEW_RUNNING
       │
       ▼
  REVIEW_COMMENTING
       │
       ├──► REVIEW_WATCHING ──► REVIEW_RUNNING  (new patchset)
       │           │
       │           └──► REVIEW_DONE
       │
       └──► REVIEW_DONE
       │
       └──► REVIEW_FAILED  (any state)
```

### 4.3 Full transition table

| From | To (allowed) |
|------|-------------|
| `DETECTED` | `CONTEXT_BUILDING`, `FAILED` |
| `CONTEXT_BUILDING` | `AGENT_RUNNING`, `FAILED` |
| `AGENT_RUNNING` | `IN_REVIEW`, `RETRY_CYCLE`, `FAILED`, `ABANDONED` |
| `IN_REVIEW` | `FEEDBACK_PROCESSING`, `MERGED`, `ABANDONED`, `FAILED` |
| `FEEDBACK_PROCESSING` | `RETRY_CYCLE`, `IN_REVIEW`, `FAILED`, `ABANDONED` |
| `RETRY_CYCLE` | `AGENT_RUNNING`, `ABANDONED`, `FAILED` |
| `MERGED` | `CLOSING`, `DONE`, `FAILED` |
| `CLOSING` | `DONE`, `FAILED` |
| `REVIEW_PENDING` | `REVIEW_RUNNING`, `REVIEW_FAILED` |
| `REVIEW_RUNNING` | `REVIEW_COMMENTING`, `REVIEW_FAILED` |
| `REVIEW_COMMENTING` | `REVIEW_WATCHING`, `REVIEW_DONE`, `REVIEW_FAILED` |
| `REVIEW_WATCHING` | `REVIEW_RUNNING`, `REVIEW_DONE`, `REVIEW_FAILED` |
| `DONE`, `FAILED`, `ABANDONED`, `REVIEW_DONE`, `REVIEW_FAILED` | *(terminal — no outgoing transitions)* |

Same-state transition → **idempotent** (no error, no DB write).

### 4.4 Pause / Resume

Pause and resume are **not boolean columns**. They are `state_transitions` rows with `from_state == to_state` and `metadata.action = "pause"` / `"resume"`. The polling loop reads the latest such row to gate cycles.

---

## 5. Plugin system

```
  compile time: src/plugins/descriptors/<provider>.ts
       │  one unified descriptor per provider; declares a `capabilities` map
       │  (issue_tracking / code_review / source_control / agent_execution)
       ▼
  src/plugins/registry.ts  ←  src/plugins/init.ts (registers built-in descriptors)
       │
       ▼
  runtime: integrations table (SQLite)
       │  provider, configJson, enabled
       ▼
  PluginManager.loadFromDatabase()
       │  capability factory(configJson) → connector instance
       ▼
  activeInstancesById[integrationId] = instance
```

### Built-in providers

| Provider | Domain capabilities |
|----------|---------------------|
| `redmine` | issue_tracking |
| `gitlab` | issue_tracking, code_review, source_control |
| `github` | issue_tracking, code_review, source_control |
| `gerrit` | code_review, source_control |
| `copilot` | agent_execution |
| `claude` | agent_execution |
| `aider` | agent_execution |
| `mock` | agent_execution |

Technical capabilities (`oauth`, `discovery`, `stream-events`, `reviewer`) are derived from descriptor hooks. Multiple integrations of the same provider can be active simultaneously. The orchestrator routes by `integrationId` in project mode, and may build a project-bound connector instance when the VE project owns part of the provider binding.

---

## 6. Database schema

All timestamps stored as **seconds since epoch** (`mode: "timestamp"` in Drizzle). Use `datetime(col, 'unixepoch')` in raw SQL.

### Core tables

```
tasks
  task_id          TEXT  PK
  display_id       TEXT
  ticket_id        TEXT  NOT NULL
  ticket_source_label TEXT
  ticket_title     TEXT
  ticket_description TEXT
  state            TEXT  (TaskState)
  task_type        TEXT  "code-gen" | "code-review"
  gerrit_change_id TEXT
  current_patchset INTEGER
  reviewed_patchset INTEGER
  push_ref         TEXT
  cycle_count      INTEGER
  failure_reason   TEXT
  ticket_url       TEXT
  review_url       TEXT
  project_id       TEXT  → projects.id (nullable — orphaned on project delete)
  ticket_source_integration_id TEXT   ← snapshot for orphan re-adoption
  ticket_source_project_key    TEXT   ← snapshot for orphan re-adoption
  created_at / updated_at  INTEGER (epoch s)

state_transitions
  id               INTEGER  PK autoincrement
  task_id          TEXT  → tasks.task_id
  from_state / to_state  TEXT
  metadata         TEXT  JSON (includes action:"pause"|"resume")
  created_at       INTEGER

agent_cycles
  id               INTEGER  PK autoincrement
  task_id          TEXT  → tasks.task_id
  cycle_number     INTEGER
  agent_result     TEXT  JSON (AgentResult)
  validation_result TEXT  JSON | null
  agent_events     TEXT  JSON (AgentLogEvent[])
  cost_ai_credits / cost_usd / premium_requests  REAL | null
  cost_input_tokens / cost_output_tokens
  cost_cached_tokens / cost_cache_write_tokens   INTEGER | null
  cost_model_id    TEXT | null      ← derived by computeCycleCost()
  created_at       INTEGER

processed_comments
  id / task_id / gerrit_comment_id / created_at

posted_review_comments           ← dedup ledger: VE-as-reviewer inline comments
  id INTEGER PK / task_id / change_id
  comment_hash  (sha1(file + "\n" + normalized message), line excluded)
  file / line / message / severity
  provider_thread_id (nullable) / resolved (0|1) / created_at
  UNIQUE(task_id, comment_hash)  → INSERT OR IGNORE idempotency

review_thread_replies            ← dedup ledger: VE replies to human threads
  id INTEGER PK / task_id / change_id / thread_id
  handled_comment_hash / reply_message / created_at
  UNIQUE(task_id, thread_id, handled_comment_hash)
```

### Integration & config tables

```
integrations
  id               TEXT  PK
  provider         TEXT  github | gitlab | gerrit | redmine | copilot | claude | aider | mock
  name             TEXT
  config_json      TEXT  JSON (credentials + endpoints)
  enabled          INTEGER  0|1  (default 1)
  discovered_resources_json TEXT | NULL
  discovered_at    INTEGER | NULL
  created_at / updated_at

prompts
  id / label / content / prompt_type ("system"|"user", default "user")
  created_at / updated_at

oauth_apps                     ← per-host OAuth app registrations
  provider + base_url  (composite PK) / client_id / timestamps
  (a legacy gitlab_oauth_apps table also exists)
```

### Project tables

```
agents
  id / name / type / model_config_json / integration_id
  system_prompt_id / instructions_prompt_id
  feedback_instructions_prompt_id (nullable — retry-cycle override)
  max_concurrent (default 1) / enabled (default 0)

projects
  id / name / type ("coding"|"review")
  agent_id → agents.id
  agent_override_json (partial model config override)
  post_clone_script (bash, runs on host after clone)
  skill_discovery_enabled (default 0 — trust gate for local skills)
  local_skills_path (default '.github/skills' — workspace-relative local skills dir)
  skill_sources_json (DB/API default '[]' — remote npx skills sources installed when configured;
                      the admin new-project form preloads the SFL agent-skills SSH source)
  enabled (default 0)

project_integration_bindings   ← one row per (project, capability)
  id / project_id / integration_id
  capability  issue_tracking | code_review | source_control | agent_execution
  config_json  — issue_tracking: { ticketProjectKey }; code_review: { repos }
  UNIQUE(project_id, capability)
  (replaces the dropped project_ticket_source / project_review_integration /
   project_review_repos tables; cross-project ticket-source uniqueness is
   enforced in application code, not by a DB index)

project_push_targets           ← 1:N with coding project (source_control)
  project_id / integration_id / repo_key / clone_url
  target_branch / role / commit_order / local_path / ssh_key_path

change_per_repository          ← tracks per-repo change IDs
  id = "${taskId}:${repoKey}" or "${taskId}:${repoKey}:${commitIndex}"
  task_id / repo_key / change_id / review_url
  status ("OPEN"|"NEW"|"MERGED"|"ABANDONED"|"ORPHANED"|"NO_CHANGE")
  integration_id / review_system (gerrit|gitlab|github) / commit_index / subject_hash

app_concurrency                ← singleton
  id = "global" / max_concurrent (NULL = unlimited)

app_settings                   ← singleton (editable runtime workflow settings)
  id = "global"
  polling_interval_ms / max_agent_cycles / max_retry_attempts  INTEGER | NULL
    (NULL = fall back to the config.ts default; edited via admin UI →
     System Settings, hot-applied without restart)
  updated_at
```

---

## 7. Concurrency model

Two levels gate every `startTaskForProject` call. All counters are **in-memory** — they reset to 0 on process restart (tasks resume via state recovery).

```
    startTaskForProject(ticket, project)
          │
          ▼
    create task row + runWorkflow
      │
      ▼
    runAgentCycle() acquires integration slot
    key = agents.integration_id (fallback: agent id)
    limit = agents.max_concurrent
      │
      ▼
    slot acquired → run docker-heavy cycle → release()
```

  Limits are read from SQLite with a 5s TTL cache. Admin UI edits take effect within 5s. `release()` is called after each agent cycle; it never goes negative (idempotent).

---

## 8. Webhook system

```
  Incoming HTTP POST /webhooks/:integrationId/:event
          │
          ▼
  validateHmacSignature(secret = integration.configJson.webhookSecret)
          │
          ▼
  provider handler — redmine, gitlab-issue, gitlab-merge-request,
  github-pull-request (GitHub Issues arrive via the `issues` X-GitHub-Event
  on the same github endpoint)
          │
          ▼
  orchestrator.startTaskForProject(ticket)   ← issue events
   or
  triggerReviewForChange(changeId)           ← MR / PR review events
```

**Gerrit** does not use webhooks: review events arrive via an **SSH stream** listener (`gerritStreamEvents.ts`) — one persistent `ssh gerrit stream-events` process per active Gerrit integration, reconciled by `integrationStreamEvents.ts` when integrations are added/removed/toggled.

Webhook secrets are per-integration (stored in `configJson.webhookSecret`), rotatable via `PUT /api/admin/integrations/:id/webhook-secret`. The HMAC is the sole auth mechanism for the inbound webhook endpoint.

---

## 9. Agent container

### Image (`Dockerfile.agent`)

Base: `node:24-bookworm-slim`. Includes `git`, `openssh-client`, `curl`, `jq`, GitHub CLI (`gh`), Python 3, and Aider installed as an isolated `uv` tool.

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get install git openssh-client curl ca-certificates jq python3 python3-venv
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_VERSION=0.6.0 sh \
  && /root/.local/bin/uv tool install --python python3 aider-chat==0.86.2 \
  && ln -s /root/.local/bin/aider /usr/local/bin/aider
# GitHub CLI is installed from the official apt repository.
COPY agent-worker/ /agent-worker/
RUN npm --prefix /agent-worker ci --no-fund \
  && npm --prefix /agent-worker run build \
  && npm --prefix /agent-worker prune --omit=dev --no-fund
WORKDIR /workspace
```

The Copilot CLI native binary (`copilot-linux-x64`) is installed on first use into `/ve-home` (the persistent named volume), not into `/tmp`.

### Worker (`agent-worker/src/index.ts` → `dist/index.js`)

Runs inside the container. Two modes:

**Code-generation mode** (default):
1. Opens a GitHub Copilot SDK session against `/workspace` (local `copilot --headless` CLI booted in-container)
2. Sends a prompt built from `TASK_TITLE`, `TASK_DESCRIPTION`, `PRIOR_FEEDBACK_JSON`, `SYSTEM_PROMPT` (required) and the user prompt read from `USER_PROMPT_FILE`
3. Copilot edits files autonomously and may create up to `MAX_COMMITS_PER_CYCLE` local commits (Change-Ids reused on retry cycles via `ROOT_CHANGE_ID` / `PER_REPO_CHANGE_IDS_JSON`)
4. Worker collects modified files via `git status`
5. Writes JSON `AgentResult` to stdout (status, modifiedFiles, summary, commitMessage)

**Review mode** (`REVIEW_MODE=1`):
1. Reads the prompt from `USER_PROMPT_FILE` (`/ve-home/user-prompt.txt`)
2. Returns raw LLM response text to stdout (no git operations)
3. Host `reviewResultParser.ts` parses inline comments and vote

### Security constraints

| Flag | Purpose |
|------|---------|
| `--read-only` | Rootfs immutable; writes only via tmpfs or volumes |
| `--cap-drop ALL` | No Linux capabilities |
| `--security-opt no-new-privileges:true` | Prevents privilege escalation |
| `--security-opt label=disable` | Allows Copilot CLI's `mprotect(PROT_READ)` on SELinux hosts |
| `--tmpfs /tmp:rw,nosuid,size=256m` | Ephemeral scratch space, no setuid |
| `--network virtual-engineer_ve-agent-net` | Dedicated bridge — isolated from the default bridge and other containers (not `--internal`; outbound access retained for the GitHub/Copilot APIs) |

The agent receives only: `GITHUB_TOKEN`, task context env vars (title, description, model), and git author metadata. System secrets (DB path, admin token, SSH keys) are never passed to the container.
