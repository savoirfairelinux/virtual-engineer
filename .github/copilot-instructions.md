# Virtual Engineer — Copilot Guidelines

Concise, accurate facts Copilot must rely on when working in this repo. For deeper context see [.github/context/INDEX.md](./context/INDEX.md).

## Documentation auto-sync

Whenever you modify code, also update the matching docs in `.github/`. Per-area rules live in [`.github/instructions/*.instructions.md`](./instructions/) and are loaded automatically by Copilot via their `applyTo` globs:

| When you change… | …also update |
|---|---|
| `src/state/schema.ts` / `stateStore.ts` / `migrate.ts` | `context/database.md` |
| `src/state/stateMachine.ts` / `interfaces.ts` (states) | `context/state-machine.md` + this file's transition map |
| `src/config.ts` | `context/configuration.md` + this file's env table |
| `src/agents/**` / `agent-worker/**` | `context/modules/agents.md` + container-spec bullets here |
| `src/connectors/**` / `src/vcs/**` / `src/plugins/**` | `context/modules/{connectors,vcs,plugins}.md` |
| `src/admin/**` | `context/modules/admin.md` |
| `src/orchestrator/**` | `context/modules/orchestrator.md` |
| `tests/**` | `context/testing.md` (inventory + conventions) |
| `package.json`, `Dockerfile.agent`, `vitest.config.ts`, `tsconfig.json`, … | this file's Build & Test block + relevant context doc |

Updates land in the **same commit** as the code change. If a change is purely internal (no observable impact on schema, config, contracts, or behaviour), no doc edit is required.

## Build & Test (gate every change)
```
npm test            # Vitest — must pass
npm run typecheck   # zero TS errors (two passes: tsconfig.json + tsconfig.agent.json)
npm run lint        # zero ESLint errors (src, tests, agent-worker/src)
npm run dev         # start orchestrator (tsx src/index.ts)
npm run build:ui    # Vite build of the admin React SPA → dist/admin-ui
npm run db:migrate  # apply Drizzle migrations
```

Helper scripts: `npm run e2e:mock`, `npm run reset:instance`, `npm run build:agent` (agent-worker TS build), `npm run dev:ui` (Vite watch), `npm run typecheck:ui`, `npm run db:generate`.

Keep the root `@github/copilot-sdk` dependency aligned with `agent-worker/package.json`; `npm run typecheck` compiles `agent-worker/src` from the root install and relies on the same permission-handler result types.

## Architecture (one screen)

- **Orchestrator** normally runs on the **host** in development (Node.js, `tsx src/index.ts`). Optional Docker deployment uses `scripts/start-orchestrator.sh` (host networking, admin UI bound to `127.0.0.1:3100`).
- For each agent cycle the host creates Docker **named volumes**, clones the repo into a volume via a helper container, spawns an **ephemeral Docker container** (`virtual-engineer-workspace:latest`) that edits files and may create one or more local commits; push operations also run in helper containers against the volume. The **host still owns review-system credentials and push orchestration** through `src/vcs/`. Container and volumes are destroyed on exit.
- **Container constraints** (set by `buildContainerSpec` / `buildReviewContainerSpec` in `src/agents/copilotAdapter.ts`): `--read-only` rootfs, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, `--tmpfs /tmp:rw,nosuid,size=256m`, `/workspace` named-volume mount, `/ve-home` named-volume mount for agent HOME (native modules and global skills), optional `/ve-prompts` mount, `networkMode=virtual-engineer_ve-agent-net`. When the project has `skillDiscoveryEnabled` set, both coding and review containers receive `SKILL_DISCOVERY=1` plus `LOCAL_SKILLS_PATH` when configured (default `.github/skills`). Before the agent container starts, `src/workspace/workspaceRunner.ts` installs any project `skill_sources_json` external entries into the `/ve-home` volume with `npx --yes skills@1.5.16 add ... -g -a <agent> --copy -y`; the agent container receives only the installed skill files, never `SKILL_SOURCES_JSON`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, or private-key paths. SSH skill sources can use the host `SSH_AUTH_SOCK` or a per-source `sshKeyPath` only in the short-lived helper install container, and can set `sshKnownHostsPath` to enforce strict host key checking. Per-source `sshUser`/`sshPort` can complete Gerrit-style URLs that omit user/port. Skills only; MCP discovery stays off; trusted repos/sources only.
- **Persistence**: SQLite WAL via `better-sqlite3` (sync) + Drizzle ORM at `DATABASE_PATH` (default `./data/virtual-engineer.db`).
- **Providers (per capability)**: issue_tracking = Redmine | GitLab Issues | GitHub Issues; code_review / source_control = Gerrit | GitLab Merge Requests | GitHub Pull Requests; agent_execution = Copilot | Claude | Mock. Provider credentials live on `integrations`, while GitLab project selection is VE-project-owned (`project_integration_bindings` issue_tracking `{ ticketProjectKey }`, `project_push_targets.repoKey`, code_review `{ repos }` bindings).
- **Admin server** (`src/admin/`) exposes the dashboard plus integrations, agents, projects, prompts, concurrency, editable runtime settings (`GET/PUT /api/admin/settings`), webhook-secret operations, and PBAC management (groups/policies/bindings under `/api/admin/{groups,policies,permissions}`); secrets are masked on read and the runtime is hot-refreshed after integration changes. Authorization is **pure PBAC** (`src/admin/authorization/`) enforced at the route gate — every route is authorized by a declared permission, with `admin` as the only superuser bypass and role solely selecting the default policy bundle at user creation. The dashboard client is a **Vite-built React SPA** (`src/admin/ui/`, served from `dist/admin-ui`; build with `npm run build:ui`).

### Source layout
```
src/
  index.ts              # process entry; boots admin + plugins + orchestrator
  config.ts             # Zod-validated AppConfig (loads .env)
  interfaces.ts         # branded IDs, TaskState, AgentSession, AgentResult, AgentLogEvent
  copilotModel.ts       # Copilot model defaults
  logger.ts             # Pino (silent in NODE_ENV=test by default)
  admin/                # Node.js admin HTTP server; serves the Vite-built React SPA
                        # adminServer (multiplexer/auth), router, adminRouteUtils,
                        # adminTaskRoutes, adminPromptRoutes, adminStreamRoutes,
                        # adminIntegrationRoutes, adminAgentsRoutes,
                        # adminProjectsRoutes, adminConcurrencyRoutes,
                        # adminSettingsRoutes, adminWebhookRoutes,
                        # adminOverviewRoutes,
                        # dashboard (SPA shell), start/close helpers
    ui/                 # React SPA source (App.tsx, views/, components/,
                        # shell/, theme/, icons/, api.ts, states.ts)
    assets/             # static assets bundled by Vite
  agents/               # copilotAdapter, copilotConnectionValidator,
                        # copilotOAuthService, providerAuthService,
                        # copilotModelsService, cycleCost,
                        # claudeAdapter, claudeConnectionValidator,
                        # claudeModelsService,
                        # mockAgentAdapter, agentEventTypes, agentEventBus
  connectors/           # redmineConnector, gerritConnector,
                        # gerritSshClient, gerritSshReviewProvider,
                        # gerritStreamEvents, integrationStreamEvents,
                        # gitlabIssueConnector, gitlabHttpClient,
                        # gitlabMergeRequestConnector,
                        # gitlabMergeRequestReviewProvider, baseTicketConnector,
                        # githubIssueConnector, githubPullRequestReviewConnector,
                        # githubReviewProvider
  orchestrator/         # orchestrator, pollingLoop, feedbackProcessor,
                        # concurrencyTracker
  plugins/              # registry, pluginManager, init, descriptors/{index,github,
                        # gitlab,gerrit,redmine,copilot,claude,mock}.ts (unified
                        # provider descriptors; githubOAuth/gitlabOAuth helpers)
  review/               # reviewOrchestrator, copilotReviewAgent,
                        # reviewPromptBuilder, reviewResultParser,
                        # commentFilter, commentHash, commentSeverity,
                        # revisionPatchset
  state/                # schema (Drizzle), stateMachine, stateStore facade, migrate
    stores/             # domain-scoped DB modules: task, integration, project,
                        # prompt(+seeding), and agent(+concurrency)
  utils/                # ticketFooterFormatter, ticketSourceLabel, encryption,
                        # errorClassifier, gitExec, githubAuth, gitlabAuth,
                        # redactUrl
  vcs/                  # vcsConnector + gerrit/gitlab/github VcsConnectors,
                        # vcsFactory, branchNaming
  webhooks/             # webhook server + handlers/{redmine,gitlab-issue,
                        # gitlab-merge-request,github-pull-request}
  workspace/            # dockerVolume (named-volume lifecycle + execInVolume)
                        # workspaceRunner (clone + container lifecycle)
agent-worker/src/       # TS worker inside the agent container: index.ts
                        # (provider-agnostic orchestrator), providers/
                        # {types,events,copilot,claude,registry}.ts (per-provider
                        # runners + registry dispatch), commitUtils.ts,
                        # networkGuard.ts, skills.ts, validate-copilot-connection.ts;
                        # built via tsconfig.agent.json / npm run build:agent
```

## Critical Schema Facts
- `tasks` PK = `task_id` (TEXT). There is **no** `id` column. Key columns also include `display_id`, `task_type`, `gerrit_change_id`, `current_patchset`, `reviewed_patchset`, `push_ref`, `project_id`, `ticket_source_integration_id`, `ticket_source_project_key`, `cycle_count`, `failure_reason`, `ticket_url`, `review_url`, `created_at`, `updated_at`. `ticket_source_integration_id` / `ticket_source_project_key` snapshot the originating ticket source so orphaned tasks can be adopted by a future project bound to the same ticket source.
- `state_transitions`, `agent_cycles`, `processed_comments` use INTEGER `id` PKs.
- `posted_review_comments` (INTEGER `id` PK): dedup table for the **review posting** side (VE as reviewer). Columns: `task_id`, `change_id`, `comment_hash` (`sha1(file+"\n"+normalized(message))`, line excluded), `file`, `line`, `message`, `severity`, `provider_thread_id` (nullable), `resolved` (0/1), `created_at`. Unique `(task_id, comment_hash)` drives `INSERT OR IGNORE` idempotency; prevents re-posting the same finding across patchsets. Integration-agnostic.
- `review_thread_replies` (INTEGER `id` PK): dedup ledger for **discussion-thread replies** (VE answering human review comments). Columns: `task_id` (FK), `change_id`, `thread_id`, `handled_comment_hash` (`sha1(thread+"\n"+lower(author)+"\n"+normalized(message))` of the latest human comment), `reply_message`, `created_at`. Unique `(task_id, thread_id, handled_comment_hash)` drives `INSERT OR IGNORE`; VE replies once per new human message and never re-answers an already-handled thread across re-reviews. Integration-agnostic.
- `agent_cycles.agent_events` (TEXT, JSON `AgentLogEvent[]`) records the streamed agent log.
- `agent_cycles` cost columns (all nullable): `cost_ai_credits` (REAL), `cost_usd` (REAL), `premium_requests` (REAL), `cost_input_tokens` / `cost_output_tokens` / `cost_cached_tokens` / `cost_cache_write_tokens` (INTEGER), `cost_model_id` (TEXT). Derived by `computeCycleCost()` (`src/agents/cycleCost.ts`) from `assistant.usage` events (per-request: events are grouped by request identity — `apiCallId`/`providerCallId` or content signature — to drop duplicate emissions, then summed across distinct requests: `copilotUsage.totalNanoAiu` → `cost_usd`/`cost_ai_credits` where 1 AIU = 1 credit = $0.01). When `totalNanoAiu` is absent, `cost_usd` is **estimated** from `premium_requests` × $0.04 (GitHub overage rate) and `cost_ai_credits` stays null. Legacy rows are recomputed from `agent_events` on read.
- `integrations` (TEXT `id` PK): `provider`, `name`, `config_json`, `enabled` (INTEGER), `discovered_resources_json`, `discovered_at`, timestamps. `provider` is one of `github | gitlab | gerrit | redmine | copilot | claude | mock` (the former `type` column and the `category` concept were removed).
- `prompts` (TEXT `id` PK): `label`, `content`, `prompt_type` (`system | user`, default `user`), timestamps. Used to inject `SYSTEM_PROMPT` / `INSTRUCTIONS_PROMPT` into the agent container.
- `oauth_apps` (composite PK `(provider, base_url)`): `provider`, `base_url`, `client_id`, timestamps — stores per-host OAuth app registrations. A legacy `gitlab_oauth_apps` table also exists.
- `change_per_repository` (TEXT `id` PK): `task_id`, `repo_key`, `change_id`, `review_url`, `status`, `integration_id`, `review_system`, `commit_index` (INTEGER NOT NULL DEFAULT 0), `subject_hash` (TEXT), timestamps. PK format: `${taskId}:${repoKey}:${commitIndex}` when commitIndex > 0, else `${taskId}:${repoKey}`. Status values: `OPEN`, `NEW`, `MERGED`, `ABANDONED`, `ORPHANED`, `NO_CHANGE`. The `review_system` column is **kept** (not renamed) and stores `gerrit | gitlab | github` via `VcsConnector.reviewSystemLabel`.
- `project_integration_bindings` (TEXT `id` PK): `project_id`, `integration_id`, `capability` (`issue_tracking | code_review | source_control | agent_execution`), `config_json`, timestamps. `UNIQUE(project_id, capability)` (`uq_pib_project_capability`). Replaces the dropped `project_ticket_source` / `project_review_integration` / `project_review_repos` tables. `config_json` shapes: issue_tracking = `{ ticketProjectKey }`; code_review = `{ repos: string[] }`. Cross-project ticket-source uniqueness is enforced in **application code** (throws), not by a DB unique index.
- Phase 2 tables also exist and are live: `agents`, `projects`, `project_integration_bindings`, `project_push_targets` (the `source_control` binding, unchanged), and singleton `app_concurrency`.
- `app_settings` (TEXT `id` PK, singleton `id = 'global'`): nullable INTEGER columns `polling_interval_ms`, `max_agent_cycles`, `max_retry_attempts`, plus `updated_at`. Holds the editable runtime workflow settings surfaced in admin UI → System Settings. NULL = fall back to the `config.ts` default (env-seeded). On boot, `src/index.ts` resolves effective values (`db ?? config default`) and overwrites the corresponding `config` fields; `PUT /api/admin/settings` persists overrides and hot-applies them to the running `PollingLoop` (`updateConfig`), `Orchestrator` (`updateRuntime`), and admin runtime config — no restart. Store methods: `getAppSettings` / `updateAppSettings` (`src/state/stores/settingsStore.ts`).
- **Admin RBAC tables**: `users` (TEXT `id` PK, `username` UNIQUE, `password_hash`, `role` = `admin | operator | viewer`, `enabled` default 1), `user_sessions` (INTEGER `id` PK, `token_hash` UNIQUE = hash of the raw bearer token, `user_id` FK → users, `expires_at` + `last_seen_at` for sliding expiry — `getSessionByTokenHash` returns null when expired or the user is disabled), and append-only `audit_log` (INTEGER `id` PK, nullable `actor_user_id`, `actor_name`, dotted `action`, nullable `target_type`/`target_id`, `details_json` default `'{}'`, indexes `idx_audit_log_created_at`, `idx_audit_log_action_created_at`, `idx_audit_log_actor_created_at`; `listAuditEntries` orders `created_at DESC, id DESC`, default limit 50, cap 200). Stores: `src/state/stores/userStore.ts` / `auditStore.ts`; duplicate username throws Error with `code = "DUPLICATE"`.
- **PBAC tables** (policy-based access control, layered over roles): `groups` (TEXT `id` PK, `name` UNIQUE, `description`), `group_members` (composite PK `(group_id, user_id)`, both FKs cascade), `policies` (TEXT `id` PK, `name` UNIQUE, `builtin` INTEGER default 0), `policy_rules` (TEXT `id` PK, `policy_id` FK cascade, `permission` = `"<resourceType>.<action>"`, nullable `resource_id` = NULL grants all resources of that type / else scoped), `policy_bindings` (TEXT `id` PK, `policy_id` FK cascade, `principal_type` = `user|group`, `principal_id`, UNIQUE `uq_policy_bindings`). Stores: `src/state/stores/groupStore.ts` / `policyStore.ts`. A user's effective permissions = union of rules from policies bound to the user + their groups (`getEffectivePolicyRulesForUser`); `admin` role bypasses as superuser. Built-in `Operator`/`Viewer` policies are seeded (`src/admin/authorization/seedPolicies.ts`) and legacy/new operator/viewer users auto-bound (role = default access bundle). Engine + catalog: `src/admin/authorization/{permissions,policyEngine,seedPolicies}.ts`. Authorization is **pure PBAC**: the route gate enforces `RouteMeta.permission` (+ `resourceParam` for resource scoping / `collection` for list routes), or `RouteMeta.authenticated` for auth-self routes — there is **no role fallback**. Only `project.*` and `task.*` are scopeable (task rules scope by owning project id; the API rejects a `resource_id` on any other/global permission); integrations/agents/prompts and admin capabilities are global. Roles remain only as the `admin` superuser bypass and the default-policy-bundle selector at user creation. All ~95 admin routes are permission-annotated (403 → `{ error, permission }`).
- `agents.enabled` defaults to `0` (disabled), not `1`.
- `projects.skill_discovery_enabled` (INTEGER, default `0`) is a **per-project** trust gate available to both coding and review projects. When 1, the orchestrator forwards it on `AgentSession.skillDiscoveryEnabled` (coding) or `ReviewWorkspaceInput.skillDiscoveryEnabled` (review), and the respective `buildContainerSpec` / `buildReviewContainerSpec` injects `SKILL_DISCOVERY=1` so the in-container agent loads project-approved skills. There is no longer an `AGENT_SKILL_DISCOVERY_ENABLED` env flag.
- `projects.local_skills_path` (TEXT, default `.github/skills`) stores the workspace-relative local skills directory. The admin UI exposes it next to the `Load local skills` checkbox; the worker falls back to `.github/skills` if an invalid path reaches the container and emits one `skills.local_loaded` timeline event with the configured path and sorted local skill names.
- `projects.skill_sources_json` (TEXT JSON, default `'[]'`) stores external skill sources as `[{ source, skills, installAll?, sshUser?, sshPort?, sshKeyPath?, sshKnownHostsPath? }]`. It is ignored unless `skill_discovery_enabled = 1`; when active, the workspace runner installs sources with `npx skills` into `/ve-home` before starting the agent. Empty `skills` is valid only with `installAll: true`; `sshUser`/`sshPort`/`sshKeyPath` are optional per-source SSH connection hints, and `sshKnownHostsPath` enables strict SSH host key verification. The admin UI can list available skills dynamically via `npx skills add -l`; presets must not hardcode selected skills.
- `agents.feedback_instructions_prompt_id` (nullable, FK → `prompts.id`) is an optional **per-agent override** used only on retry (feedback) cycles. When set on a coding agent, the orchestrator swaps it in as the instructions prompt for `cycleNumber > 1`; otherwise the regular `instructions_prompt_id` is reused. The seeded default prompt is `instructions_feedback_code` (from `prompts/instructions_feedback_code.md`).
- All `created_at`/`updated_at` are stored as **seconds since epoch** (Drizzle `mode: "timestamp"`). Correct query: `datetime(created_at, 'unixepoch')`.

Quick troubleshooting query:
```sql
SELECT task_id, state, cycle_count, failure_reason
FROM tasks WHERE ticket_id = 'X' ORDER BY created_at DESC;
```

## State Machine (`src/state/stateMachine.ts`)
Two task lifecycles share the same `TaskState` union:

- **Code-gen happy path**: `DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → IN_REVIEW → MERGED → CLOSING → DONE`
- **Code-review happy path**: `REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING → REVIEW_WATCHING → REVIEW_DONE`

**Full transition map** (`VALID_TRANSITIONS`):
- `DETECTED → CONTEXT_BUILDING | FAILED`
- `CONTEXT_BUILDING → AGENT_RUNNING | FAILED`
- `AGENT_RUNNING → IN_REVIEW | RETRY_CYCLE | FAILED | ABANDONED`
- `IN_REVIEW → FEEDBACK_PROCESSING | MERGED | ABANDONED | FAILED`
- `FEEDBACK_PROCESSING → RETRY_CYCLE | IN_REVIEW | FAILED | ABANDONED`
- `RETRY_CYCLE → AGENT_RUNNING | ABANDONED | FAILED`
- `MERGED → CLOSING | DONE | FAILED`
- `CLOSING → DONE | FAILED`
- `REVIEW_PENDING → REVIEW_RUNNING | REVIEW_FAILED`
- `REVIEW_RUNNING → REVIEW_COMMENTING | REVIEW_FAILED`
- `REVIEW_COMMENTING → REVIEW_WATCHING | REVIEW_DONE | REVIEW_FAILED`
- `REVIEW_WATCHING → REVIEW_RUNNING | REVIEW_DONE | REVIEW_FAILED`

**Terminal**: `DONE`, `FAILED`, `ABANDONED`, `REVIEW_DONE`, `REVIEW_FAILED` (no outgoing transitions). Same-state → `"idempotent"`. Anything else → `InvalidTransitionError`.

**Pause/Resume** are NOT boolean columns. `stateStore.pauseTask()` writes a `state_transitions` row with `from_state == to_state` and `metadata.action = "pause"` (similarly for `"resume"`). Polling reads the latest pause-row to gate cycles.

**Retry counting** is source-aware (per-ticket FAILED/ABANDONED count vs. `MAX_RETRY_ATTEMPTS`). No-change agent outcomes can transition to `ABANDONED` instead of cycling.

## Key Configuration (`src/config.ts`)
All env vars are optional. Only system/infra settings remain — provider credentials live exclusively in the database.

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `test` silences logger |
| `LOG_LEVEL` | `info` | pino levels |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | |
| `ADMIN_API_ENABLED` | `true` | |
| `ADMIN_API_HOST` / `ADMIN_API_PORT` | `127.0.0.1` / `3100` | |
| `ADMIN_AUTH_SECRET` | — | Encryption key for OAuth/session tokens at rest (AES-256-GCM). Admin auth itself uses DB-backed user accounts + session tokens, not HMAC. |
| `ADMIN_TRUST_PROXY` | `false` | When `true`, extract client IP from `X-Forwarded-For` for rate-limiting. Only enable when a trusted reverse proxy fronts the admin server; default loopback binding makes this unnecessary in standard deployments. |
| `POLLING_INTERVAL_MS` | `30000` | **DB-managed** default seed — polling loop tick interval; runtime value lives in `app_settings` and is edited from admin UI → System Settings |
| `MAX_AGENT_CYCLES` | `3` | **DB-managed** default seed — per-task cap → FAILED; runtime value in `app_settings` |
| `MAX_RETRY_ATTEMPTS` | `5` | **DB-managed** default seed — per-ticket cap; runtime value in `app_settings` |
| `MAX_COMMITS_PER_CYCLE` | `10` | max atomic commits per agent cycle |
| `AGENT_TIMEOUT_MS` | `3_600_000` | host-side agent timeout (60 min) |
| `MAX_REVIEW_DIFF_CHARS` | `60_000` | max diff chars injected into review prompt |
| `MAX_REVIEW_COMMENTS` | `20` | max inline comments posted per review pass (excess folded into summary) |
| `MAX_REVIEW_REPLIES` | `20` | max discussion-thread replies VE posts per review pass |
| `REVIEW_MIN_SEVERITY` | `info` | min severity (`nit`<`info`<`warning`<`error`) to post inline; lower folded into summary |
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | scratch space for review diffs; agent workspaces use Docker named volumes |
| `AGENT_DOCKER_NETWORK` | `virtual-engineer_ve-agent-net` | Docker network for agent containers |

Provider configuration (Redmine, Gerrit, GitLab credentials, ticket-source/push-target selection, agent model and prompts, project lifecycle) lives entirely in the `integrations`, `agents`, `projects`, `project_integration_bindings`, and `project_push_targets` tables and is managed via the admin UI. The legacy provider env vars (`TICKET_SYSTEM`, `REVIEW_SYSTEM`, `REDMINE_*`, `GERRIT_*`, `GITLAB_*`, `REPO_CLONE_URL`, `BASE_BRANCH`, `GERRIT_TARGET_BRANCH`) have been **removed** from `src/config.ts` as part of Phase 7 cleanup.

Workflow settings (`POLLING_INTERVAL_MS`, `MAX_AGENT_CYCLES`, `MAX_RETRY_ATTEMPTS`) are **editable at runtime** from admin UI → System Settings and persisted in the `app_settings` singleton table. Their `config.ts` entries remain only as the first-run/default seed (no longer set in `.env.example`); the DB value wins once saved.

Empty strings in env are treated as `undefined` (helpful for env overrides).


## Plugin System (`src/plugins/`)
- Static **registry** (`registry.ts`) defines one unified **provider descriptor** per `provider` in `src/plugins/descriptors/{github,gitlab,gerrit,redmine,copilot,claude,mock}.ts`. The former split descriptors were merged: `github-issue` + `github-pull-request` → `github`; `gitlab-issue` + `gitlab-merge-request` → `gitlab`. `PLUGIN_CATEGORIES` / `category` no longer exist.
- Descriptors declare a `capabilities` map keyed by **domain capability** (`issue_tracking`, `code_review`, `source_control`, `agent_execution`) with capability factories: `capabilities.issue_tracking.createConnector`, `capabilities.code_review.{createConnector,createReviewer,streamEvents,systemPromptId,userPromptId}`, `capabilities.source_control.createVcsConnector`, `capabilities.agent_execution.createAdapter`. Technical capabilities (`oauth`, `discovery`, `stream-events`, `reviewer`) are derived from descriptor hooks via `getProviderTechnicalCapabilities(descriptor)`; domain ones via `getProviderDomainCapabilities(descriptor)`.
- **PluginManager** loads every enabled row from `integrations`, keeps multiple active integrations in parallel even for the same provider, resolves by `integrationId` (`getConnectorForIntegration`, `getActiveIntegrationById`, `isIntegrationActive`) or by capability/provider (`getConnectorForCapability(integrationId, capability)`, `getActiveIntegrationsByCapability(capability)`, `getActiveIntegrationsByProvider(provider)`, `providerSupportsCapability(provider, capability)`). `integrationHasStreamEvents` checks `capabilities.code_review.streamEvents`. It can also build project-bound connector instances via `createConnectorForIntegration(integrationId, context)` when a VE project owns part of the provider binding.
- Admin dashboard / API can hot-add or toggle integrations; `src/index.ts` refreshes runtime dependencies without restart.
- Test the connection of an unsaved form via `POST /api/admin/integrations/test` (does not persist; merges masked secrets from the existing row when `integrationId` is supplied).

## Copilot Execution

1. **Worker-local headless CLI** — code-generation containers always spawn `copilot --headless` inside the container and connect the SDK to that local CLI server.
2. **Docker review execution** — review tasks also run in the agent container (`REVIEW_MODE=1` via `workspaceRunner.runReviewInDocker`); the worker reads the prompt from `USER_PROMPT_FILE` (`/ve-home/user-prompt.txt`) and returns raw LLM text for the host to parse. `src/review/copilotReviewAgent.ts` (host-side SDK client) is **legacy** — never instantiated in `src/`.
3. **Container validation fallback** — when the local Node runtime lacks `node:sqlite`, `copilotConnectionValidator` runs the validation script inside `AGENT_CONTAINER_IMAGE`, which also starts a local headless CLI in-container.

Worker `sendAndWait` timeout ≈ 540s. Host agent timeout = `AGENT_TIMEOUT_MS` (default 60 min).

Implementation: `src/agents/copilotAdapter.ts`, `src/agents/copilotOAuthService.ts`, `src/agents/copilotModelsService.ts`, `src/agents/copilotConnectionValidator.ts`, `src/review/copilotReviewAgent.ts`, `agent-worker/src/index.ts`.

## Claude Execution (`agent_execution` alternative to Copilot)

The `claude` provider runs Anthropic **Claude Code** via the `@anthropic-ai/claude-agent-sdk` inside the same agent container. The host `ClaudeAdapter` (`src/agents/claudeAdapter.ts`) injects `AGENT_PROVIDER=claude`, exactly one auth env var, and `CLAUDE_MODEL` **only when a model is configured** (otherwise the Claude CLI picks its own default — no hardcoded default in VE). The Claude runner (`agent-worker/src/providers/claude.ts`, resolved by the worker's provider registry when `AGENT_PROVIDER=claude`) drives `query()` and maps its message stream onto the shared `__ve_event` / commit / `AgentResult` pipeline. Both coding and review flows are supported (review uses `REVIEW_MODE=1`).

Agent adapters are **descriptor-driven**: a provider that declares `capabilities.agent_execution.buildAdapter(context)` is instantiated by `PluginManager` from an `AgentAdapterContext` (`maxCommitsPerCycle`, `dockerNetwork`) supplied via constructor options. `index.ts` no longer registers per-provider adapter factories — adding a new agent backend is just a new descriptor. `PluginManager.registerFactory` still exists and takes precedence (used by tests).

Two connection methods (descriptor `src/plugins/descriptors/claude.ts`, `authMode`):
- `api_key` — Anthropic API key → `ANTHROPIC_API_KEY` (carried via the generic `apiKey`/`agentSession.githubToken` field).
- `subscription` — Claude Pro/Max OAuth token → `CLAUDE_CODE_OAUTH_TOKEN` (carried via `encryptedSessionToken`); obtained through the interactive authorization-code + PKCE OAuth flow (`src/plugins/descriptors/claudeOAuth.ts`, stored encrypted in `sessionToken`). `orchestrator.resolveProjectAgentRuntime` maps these provider-specific fields onto the generic `ResolvedAgentConfig`.

Cost: Claude has no AIU, so `agent_cycles` USD/credit columns stay null; token usage is still emitted as `assistant.usage` events. Claude OAuth client id/endpoints are fixed public Claude Code values (not overridable via config — intentionally hard-coded to prevent SSRF/credential redirection) — see `claudeOAuth.ts`.

## Test Layout
- **Unit + integration tests**: `tests/unit/` (Vitest). All external I/O (fetch, fs, Docker, SDK) is mocked via `vi.mock`/`vi.spyOn`. Current project-mode and webhook-oriented scenarios live alongside unit specs (for example `orchestrator.projectMode.test.ts`, `orchestrator.webhookEntryPoints.test.ts`, `pollingLoop.projects.test.ts`).
- **Helpers/fixtures**: `tests/unit/helpers/`.

## Development Workflow (TDD mandatory)
Use the `ve-tdd` skill. Gate every commit on the three checks above. Reuse the `tested-engineer` agent for full TDD cycles, `codebase-analyst` for read-only review, `log-debugger` for runtime diagnosis, `dev-coordinator` for multi-stage features (see [DEVELOPMENT-WORKFLOW.md](./DEVELOPMENT-WORKFLOW.md)).

## TypeScript / Lint Conventions
- ESM with NodeNext: imports require `.js` suffix (`from "./foo.js"`).
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`.
- No `any` in `src/` — use `unknown` + type guards.
- Optional props: declare `T | undefined` explicitly.
- Unused locals/params must be `_`-prefixed.

## Commit Messages (Conventional Commits, Gerrit-friendly)
`<type>(<scope>): <≤50-char subject>`

Types: `feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `chore`, `ci`.
Scopes: `orchestrator`, `polling-loop`, `state`, `gerrit`, `redmine`, `gitlab`, `agent`, `copilot-cli`, `vcs`, `plugins`, `admin`, `dashboard`, `prompts`, `config`, `workspace`, `db`.
Body lines ≤72 chars. See `typescript-standard` skill.

## Recent Gotchas
- **Orphaned-task adoption**: `deleteProject` snapshots `(integrationId, ticketProjectKey)` onto the project's tasks, sets their `project_id` to `NULL`, and abandons non-terminal ones. When a new project is created and `setProjectTicketSource` binds the same `(integrationId, ticketProjectKey)`, `adoptOrphanedTasksForProject` re-attaches those orphan tasks to the new project — preventing "No ticket source configured for project …" errors.
- **Copilot defaults**: `src/copilotModel.ts` only defines the default model (`auto`); runtime code should trim optional overrides but not rewrite model ids.
- **Task resolution**: `getTaskByTicketId()` orders by `createdAt DESC` so polling sees the newest task, not a stale FAILED row.
- **Pause/Resume** are state_transitions metadata rows, not boolean columns.
- **Plugin reload**: editing integrations triggers `refreshRuntimeDependencies()` from `src/index.ts`; no orchestrator restart needed.
- **Container image rebuild**: after editing `src/agents/copilotAdapter.ts`, `agent-worker/src/**`, or `Dockerfile.agent`, run `docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .` and restart `npm run dev`.
- **Timestamp queries**: stored in seconds → `datetime(created_at, 'unixepoch')` (NOT `created_at/1000`).
- **`exactOptionalPropertyTypes`**: when forwarding optional fields, prefer conditional spreading (`...(x !== undefined ? { x } : {})`) over `x: x ?? undefined`.
- **Provider config lives in admin DB**: do not add new env-var-driven provider settings — extend the relevant `integrations` descriptor or the `agents` / `projects` tables instead.
- **GitLab project binding is project-owned**: do not reintroduce GitLab `projectId`, label IDs, or label names into Add Integration forms; use `ticketProjectKey` / `repoKey` from VE project configuration and treat old integration fields as compatibility fallbacks only.
- **One provider, many capabilities**: there is no longer a `github-issue` vs `github-pull-request` (or `gitlab-issue` vs `gitlab-merge-request`) split. A single `github` / `gitlab` provider descriptor exposes multiple domain capabilities; resolve runtime dependencies by capability (`getConnectorForCapability`, `getActiveIntegrationsByCapability`) rather than by an integration type/role.
- **Ticket-source uniqueness is app-enforced**: there is no DB unique index across projects for the issue_tracking binding. `projectStore` throws when a second project binds the same `(integrationId, ticketProjectKey)`; keep that check in application code.
- **Multi-instance plugins**: all enabled integrations stay active in memory, including multiple rows of the same provider. Resolve runtime dependencies by `integrationId`, capability, or explicit integration lists; do not add new logic that assumes a single active integration per provider.
- **Copilot execution path**: no host/external CLI server support remains. Containers and validation scripts always boot a local headless CLI; reviews run in the agent container with `REVIEW_MODE=1` (`CopilotReviewAgent` is legacy, unused).
- **Descriptor-driven event streams**: stream-capable integrations are reconciled through `descriptor.streamEvents` plus `PluginManager.getActiveIntegrations()`. Gerrit is the current stream-backed implementation, but the bootstrap is no longer Gerrit-specific.
- **Descriptor-driven review backends**: generic review routing resolves active review integrations through `descriptor.createReviewer`; keep provider-specific clone/setup logic in the descriptor and out of `src/index.ts` / `src/review/reviewOrchestrator.ts`.
- **Review tasks are integration-scoped**: webhook-triggered review flows must resolve the exact review integration by `integrationId`, and code-review tasks should preserve that integration in `ticketSourceLabel` / derived `ticketId` to avoid collisions between multiple active Gerrit instances.
- **Review event intake is provider-specific**: Redmine / GitLab still use per-integration webhook secrets in `configJson.webhookSecret`, while Gerrit review events now come from one host-side `ssh gerrit stream-events` listener per active integration.
- **Three event-intake mechanisms**: work reaches VE via **polling** (`PollingLoop`), **webhooks** (`src/webhooks/`, `PROVIDER_HANDLERS`), or **stream-events** (Gerrit SSH). Each capability declares its `intake` (`polling | webhook | stream`) in the descriptor; resolve per-integration via `PluginManager.getIntegrationCapabilityIntake(integrationId, capability)`. All three tag tasks with the canonical `<provider>:<integrationId>` label (`src/utils/ticketSourceLabel.ts`) — issue connectors return bare provider ids (`gitlab`/`github`, not `gitlab-issue`/`github-issue`) and the footer formatter strips the `:integrationId` suffix before lookup. GitHub Issues are ingested via the `issues` `X-GitHub-Event` in the github webhook handler.
- **Concurrency gating is integration-scoped at agent-cycle time**: `ConcurrencyTracker` keys limits by `agents.integrationId` using `agents.maxConcurrent`. It no longer gates `PollingLoop` or `startTaskForProject`; it gates active `runAgentCycle` executions (Docker-heavy phase) and releases at cycle end.
- **Review idempotency keys on `reviewedPatchset`, not state**: `startReviewTask` skips automatic re-triggers when `existing.reviewedPatchset === details.currentPatchset` (covers REVIEW_WATCHING *and* terminal REVIEW_DONE rows) — this prevents the duplicate reviews seen on project resync (stream backfill / polling / webhook re-deliveries). `StartReviewInput.force` (and `runReview(taskId, { force })`) bypasses the skip for **manual** relaunches only: re-adding VE as a Gerrit reviewer (`gerritStreamEvents.ts` `reviewer-added` → `triggerReviewForChange(..., { force: true })`). Force re-runs the agent and re-posts vote + summary, but inline-comment dedup (`posted_review_comments`) is preserved so no duplicate inline comments are posted. New patchsets always re-review regardless of force. Do NOT thread `force` into automatic paths (patchset-created, backfill, GitLab/GitHub webhooks).
