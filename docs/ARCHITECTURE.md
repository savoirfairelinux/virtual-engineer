# Virtual Engineer — Architecture

---

## 1. System overview

Virtual Engineer is a **Node.js orchestrator** that runs on the host (or in a Docker container) and drives two autonomous workflows:

- **Code generation** — picks up tickets, clones the repo into an ephemeral Docker container, lets Copilot implement the changes, then pushes for review.
- **Code review** — receives Gerrit events via SSH stream or HTTP webhook, runs Copilot on the diff inside a Docker container, and posts inline comments + a vote.

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  HOST PROCESS  (Node.js orchestrator, src/index.ts)                      │
  │                                                                          │
  │  ┌────────────────┐  poll 30s   ┌───────────────────────────────────┐   │
  │  │  Ticket System │◄────────────│  PollingLoop                      │   │
  │  │  Redmine /     │             └──────────────┬────────────────────┘   │
  │  │  GitLab Issues │                            │ startTaskForProject    │
  │  └────────────────┘                            ▼                        │
  │                                ┌───────────────────────────────────┐   │
  │  ┌────────────────┐  SSH/HTTP  │  Orchestrator                     │   │
  │  │  Review System │◄───────────│  runWorkflow / state machine      │   │
  │  │  Gerrit /      │            └──────────────┬────────────────────┘   │
  │  │  GitLab MR     │                            │                        │
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
                                 │  node /agent-worker/index.js            │
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
  copilotModel.ts       # Default model constant
  logger.ts             # Pino logger factory (silent in test)

  admin/                # HTTP admin server + dashboard HTML
    adminServer.ts        # Thin route multiplexer, auth, security headers
    adminRouteUtils.ts    # Shared HTTP primitives (writeJson, readBody, etc.)
    adminTaskRoutes.ts    # /api/admin/tasks CRUD + actions
    adminPromptRoutes.ts  # /api/admin/prompts CRUD
    adminStreamRoutes.ts  # SSE endpoints (logs/stream, events/stream)
    adminIntegrationRoutes.ts # /api/admin/integrations + plugins + oauth-apps
    adminAgentsRoutes.ts  # /api/admin/agents CRUD + plugin OAuth
    adminProjectsRoutes.ts# /api/admin/projects CRUD
    adminConcurrencyRoutes.ts # /api/admin/concurrency
    adminWebhookRoutes.ts # Webhook secret rotation, allowed-IPs, info
    dashboard.ts          # Single-page HTML dashboard (inline)
    startAdminServer.ts   # net.Server lifecycle wrapper
    closeAdminServer.ts

  agents/               # Agent adapters and event infrastructure
    copilotAdapter.ts     # Builds container spec, parses AgentResult
    copilotConnectionValidator.ts
    copilotModelsService.ts
    copilotOAuthService.ts
    mockAgentAdapter.ts   # Deterministic mock, no Copilot needed
    agentEventBus.ts      # SSE event bus for live log streaming
    agentEventTypes.ts

  connectors/           # External system connectors
    gerritConnector.ts    # Gerrit SSH review API
    gerritSshReviewProvider.ts
    gerritStreamEvents.ts    # Gerrit SSH event stream listener
    gitlabIssueConnector.ts
    gitlabMergeRequestConnector.ts
    integrationStreamEvents.ts  # Descriptor-driven stream reconciler
    redmineConnector.ts

  orchestrator/
    orchestrator.ts       # Ticket workflow driver (state machine caller)
    pollingLoop.ts        # 30s tick → per-project connector poll
    feedbackProcessor.ts  # Parses review comments into retry context
    concurrencyTracker.ts # 3-level in-memory concurrency gates

  plugins/              # Plugin system
    registry.ts           # Static type → descriptor map
    pluginManager.ts      # DB-driven instance lifecycle
    init.ts               # Registers factories + testers at startup
    descriptors/          # One file per integration type

  review/               # Code-review workflow
    reviewOrchestrator.ts # REVIEW_PENDING → REVIEW_DONE lifecycle
    copilotReviewAgent.ts # Host-side Copilot agent for reviews
    reviewPromptBuilder.ts
    reviewResultParser.ts

  state/
    schema.ts             # Drizzle table definitions
    stateMachine.ts       # VALID_TRANSITIONS + validateTransition
    stateStore.ts         # SqliteStateStore — all DB access
    migrate.ts            # Runs Drizzle migrations on startup

  utils/
    encryption.ts         # AES-256-GCM token encryption
    ticketFooterFormatter.ts

  vcs/                  # Repository operations (clone, push, MR creation)
    vcsConnector.ts       # Interface
    gerritVcsConnector.ts # SSH clone + push via helper containers
    gitlabVcsConnector.ts # HTTP clone + push + MR creation
    vcsFactory.ts         # createVcsConnectorForIntegration(integration, context?)

  webhooks/             # Inbound webhook receiver
    webhookServer.ts
    handlers/             # Per-provider HMAC-validated handlers

  workspace/
    dockerVolume.ts       # createVolume / removeVolume / execInVolume
    workspaceRunner.ts    # DockerWorkspaceRunner — orchestrates clone+run+push

agent-worker/
  index.js              # Runs INSIDE the agent container (Copilot SDK)
  validate-copilot-connection.js
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

Project mode injects `ProjectModeDeps` which provides per-project agent resolution, VCS connector, and the `ConcurrencyTracker`. In project mode the orchestrator resolves the agent and VCS connector from the project's bindings — not from global env vars. GitLab ticket selection comes from `project_ticket_source.ticketProjectKey`, and GitLab MR/push selection comes from the relevant project `repoKey`.

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
- Concurrency: skips projects where `ConcurrencyTracker.canStart()` returns false; logs at most once per tick.
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
       │           node /agent-worker/index.js
       │
       ├─ execInVolume(commit helper)  ← git add + git commit (with Change-Id)
       ├─ execInVolume(push helper)    ← git push refs/for/<branch>
       │
       └─ removeVolume(ve-ws) + removeVolume(ve-home)
```

`execInVolume` injects SSH keys via a base64-encoded env var (decoded inside the helper and written to `/tmp/ssh-key`) to avoid host-path bind-mount issues when the orchestrator itself runs in Docker.

---

### 3.4 Admin Server

`src/admin/adminServer.ts` — thin multiplexer and auth gate.

Plain Node.js `http.createServer` — no framework. The main file handles auth, security headers, and public endpoints (dashboard, health, img-proxy), then dispatches to modular route handlers that each follow the pattern `handleXxxRoute(req, res, path, method, deps): Promise<boolean>`.

**Authentication:** `Authorization: Bearer <hex-HMAC-SHA256>` when `ADMIN_AUTH_SECRET` is set. Comparison uses `crypto.timingSafeEqual`.

**Route modules:**

| Module | Route group |
|--------|-------------|
| `adminServer.ts` | Dashboard (`GET /admin`), health (`GET /health`), img-proxy, status, config, providers |
| `adminTaskRoutes.ts` | `GET/DELETE /api/admin/tasks`, `GET /api/admin/tasks/:id`, `GET .../cycles`, `GET .../transitions`, `PATCH .../pause`, `PATCH .../resume`, `POST .../retry`, `POST .../abandon` |
| `adminPromptRoutes.ts` | `GET/POST /api/admin/prompts`, `GET/PUT/DELETE /api/admin/prompts/:id`, `GET .../usage` |
| `adminStreamRoutes.ts` | `GET /api/admin/logs/stream` (SSE), `GET /api/admin/events/stream` (SSE) |
| `adminIntegrationRoutes.ts` | `GET/POST /api/admin/integrations`, `GET/PUT/DELETE .../integrations/:id`, `POST .../test`, `PATCH .../{enable,disable}`, `POST .../discover`, `GET .../models`, `GET /api/admin/plugins`, `GET/POST/DELETE /api/admin/oauth-apps` |
| `adminAgentsRoutes.ts` | `GET/POST /api/admin/agents`, `GET/PUT/DELETE .../agents/:id`, `PATCH .../{enable,disable}`, `POST /api/admin/plugins/:type/oauth/*` |
| `adminProjectsRoutes.ts` | `GET/POST /api/admin/projects`, `GET/PUT/DELETE .../projects/:id`, `PATCH .../{enable,disable}` |
| `adminConcurrencyRoutes.ts` | `GET/PUT /api/admin/concurrency` |
| `adminWebhookRoutes.ts` | `POST .../webhook-secret/rotate`, `GET/PUT .../webhook-allowed-ips`, `GET .../webhook-info` |

**Shared primitives** (`adminRouteUtils.ts`): `writeJson`, `writeHtml`, `readBody` (512 KB limit), `toIsoTimestamp`, `asRecord`, `SECRET_MASK`.

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
         factory(configJson)  →  connector instance
         store in activeInstancesById[id]
         if type not yet claimed → also set as type-leader in activeInstances[type]

  runtime lookup
    getConnectorForIntegration(id)  →  instance from activeInstancesById
    getActiveIntegrationsByType(t)  →  all active instances of a type
    getActiveConnector(category)    →  type-leader for a category (legacy)
```

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
       ├─ docker run → agent-worker/index.js
       │     stdout: JSON AgentResult
       │     stderr: structured __ve_event lines + plain logs
       │
       └─ parseAgentResult(stdout)
             validate commitMessage against CONVENTIONAL_COMMIT_RE
             fallback to "feat: <subject>" if missing/invalid
```

The agent container is placed on `virtual-engineer_ve-agent-net` — an isolated Docker bridge network with no direct route to the host gateway.

---

### 3.7 ReviewOrchestrator

`src/review/reviewOrchestrator.ts`

Drives the **code-review lifecycle** for a single change.

```
  Gerrit patchset-created event
       │
       ▼
  createReviewTask()  →  REVIEW_PENDING
       │
       ▼
  REVIEW_RUNNING
       │
       ├─ clone repo via execInVolume
       ├─ git fetch refs/changes/<patchset>
       ├─ buildReviewPrompt(diff)
       │
       ├─ docker run (agent container, REVIEW_MODE=1)
       │     reads /tmp/review-prompt.txt
       │     returns raw LLM text → stdout
       │
       ├─ parseReviewResult(output)  →  comments + vote
       │
       ▼
  REVIEW_COMMENTING
       │
       ├─ gerritConnector.postInlineComments(comments)
       ├─ gerritConnector.setReviewVote(vote)
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

Both operate entirely via `execInVolume` — no VCS tools run directly on the orchestrator process. SSH keys are injected as base64 env vars.

`vcsFactory.ts` exports `createVcsConnectorForIntegration(integration)` which reads the integration's `configJson` and returns the appropriate connector.

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
  compile time: src/plugins/descriptors/<type>.ts
       │  registers type + category + config schema
       ▼
  src/plugins/registry.ts  ←  src/plugins/init.ts (calls registerBuiltinPlugins)
       │
       ▼
  runtime: integrations table (SQLite)
       │  type, configJson, enabled
       ▼
  PluginManager.loadFromDatabase()
       │  factory(configJson) → connector instance
       ▼
  activeInstancesById[integrationId] = instance
```

### Built-in providers

| Category | Type | Description |
|----------|------|-------------|
| `ticketing` | `redmine` | Redmine REST API |
| `ticketing` | `gitlab-issue` | GitLab Issues REST API |
| `review` | `gerrit` | Gerrit SSH review + HTTP REST |
| `review` | `gitlab-merge-request` | GitLab Merge Requests REST API |
| `agent` | `copilot` | GitHub Copilot via Copilot SDK |
| `agent` | `mock` | Deterministic mock adapter (no Copilot needed) |

Multiple integrations of the same type can be active simultaneously. The orchestrator routes by `integrationId` in project mode, and may build a project-bound connector instance when the VE project owns part of the provider binding.

---

## 6. Database schema

All timestamps stored as **seconds since epoch** (`mode: "timestamp"` in Drizzle). Use `datetime(col, 'unixepoch')` in raw SQL.

### Core tables

```
tasks
  task_id          TEXT  PK
  ticket_id        TEXT  NOT NULL
  ticket_source_label TEXT
  ticket_title     TEXT
  ticket_description TEXT
  state            TEXT  (TaskState)
  task_type        TEXT  "code-gen" | "code-review"
  gerrit_change_id TEXT
  current_patchset INTEGER
  reviewed_patchset INTEGER
  cycle_count      INTEGER
  failure_reason   TEXT
  ticket_url       TEXT
  review_url       TEXT
  project_id       TEXT  → projects.id
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
  created_at       INTEGER

processed_comments
  id / task_id / gerrit_comment_id / created_at
```

### Integration & config tables

```
integrations
  id               TEXT  PK
  type             TEXT  (IntegrationType)
  name             TEXT
  config_json      TEXT  JSON (credentials + endpoints)
  enabled          INTEGER  0|1  (default 0)
  discovered_resources_json TEXT | NULL
  discovered_at    INTEGER | NULL
  created_at / updated_at

prompts
  id / label / content / created_at / updated_at
```

### Project tables

```
agents
  id / name / type / model_config_json / integration_id
  system_prompt_id / instructions_prompt_id
  max_concurrent (default 1) / enabled (default 0)

projects
  id / name / type ("coding"|"review")
  agent_id → agents.id
  agent_override_json (partial model config override)
  post_clone_script (bash, runs on host after clone)
  max_concurrent (default 1) / enabled (default 0)

project_ticket_source          ← 1:1 with coding project
  project_id / integration_id / ticket_project_key

project_push_targets           ← 1:N with coding project
  project_id / integration_id / repo_key / clone_url
  target_branch / role / commit_order / local_path / ssh_key_path

project_review_integration     ← 1:1 with review project
  project_id / integration_id

project_review_repos           ← 1:N with review project
  project_id / repo_key

change_per_repository          ← tracks per-repo change IDs
  id = "${taskId}:${repoKey}" or "${taskId}:${repoKey}:${commitIndex}"
  task_id / repo_key / change_id / review_url
  status ("OPEN"|"MERGED"|"ABANDONED"|"NO_CHANGE")
  integration_id / review_system / commit_index / subject_hash

app_concurrency                ← singleton
  id = "global" / max_concurrent (NULL = unlimited)
```

---

## 7. Concurrency model

Three levels gate every `startTaskForProject` call. All counters are **in-memory** — they reset to 0 on process restart (tasks resume via state recovery).

```
  startTaskForProject(ticket, project)
          │
          ▼
  ConcurrencyTracker.canStart(projectId, agentId)
          │
     ┌────┴────────────────────────────────────┐
     │                                         │
     ▼                                         ▼
  global counter                    per-project counter
  vs app_concurrency.max_concurrent  vs projects.max_concurrent
          │
          ▼
  per-agent counter
  vs agents.max_concurrent
          │
          ▼ all pass → acquire() → create task
          │ any fail → defer (retry next tick)
```

Limits are read from SQLite with a 5s TTL cache. Admin UI edits take effect within 5s. `release()` is called when a task reaches a terminal state; it never goes negative (idempotent).

---

## 8. Webhook system

```
  Incoming HTTP POST /webhooks/:integrationId/:event
          │
          ▼
  validateHmacSignature(secret = integration.configJson.webhookSecret)
          │
          ▼
  provider handler (e.g. gerrit: patchset-created, change-merged)
          │
          ▼
  orchestrator.handleReviewEvent(changeId)
   or
  pollingLoop.resetBackoff() + immediate poll trigger
```

**Gerrit** also supports an **SSH stream** listener (`gerritStreamEvents.ts`): one persistent `ssh gerrit stream-events` process per active Gerrit integration, reconciled by `integrationStreamEvents.ts` when integrations are added/removed/toggled.

Webhook secrets are per-integration (stored in `configJson.webhookSecret`), rotatable via `PUT /api/admin/integrations/:id/webhook-secret`. The HMAC is the sole auth mechanism for the inbound webhook endpoint.

---

## 9. Agent container

### Image (`Dockerfile.agent`)

Base: `node:24-bookworm-slim`. Includes: `git`, `openssh-client`, `curl`, `jq`, GitHub CLI (`gh`).

```
FROM node:24-bookworm-slim
RUN apt-get install git openssh-client curl ca-certificates jq gh
COPY agent-worker/ /agent-worker/
RUN npm --prefix /agent-worker ci --omit=dev
WORKDIR /workspace
```

The Copilot CLI native binary (`copilot-linux-x64`) is installed on first use into `/ve-home` (the persistent named volume), not into `/tmp`.

### Worker (`agent-worker/index.js`)

Runs inside the container. Two modes:

**Code-generation mode** (default):
1. Opens a GitHub Copilot SDK session against `/workspace`
2. Sends a prompt built from `TASK_TITLE`, `TASK_DESCRIPTION`, `PRIOR_FEEDBACK_JSON`, `SYSTEM_PROMPT`, `INSTRUCTIONS_PROMPT`
3. Copilot edits files autonomously
4. Worker collects modified files via `git status`
5. Writes JSON `AgentResult` to stdout (status, modifiedFiles, summary, commitMessage)

**Review mode** (`REVIEW_MODE=1`):
1. Reads prompt from `REVIEW_PROMPT_FILE` (`/tmp/review-prompt.txt`)
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
| `--network virtual-engineer_ve-agent-net` | Isolated bridge — no host gateway access |

The agent receives only: `GITHUB_TOKEN`, task context env vars (title, description, model), and git author metadata. System secrets (DB path, admin token, SSH keys) are never passed to the container.
