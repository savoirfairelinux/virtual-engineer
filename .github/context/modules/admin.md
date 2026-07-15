# Modules — Admin Server

**Source:** [src/admin/](../../../src/admin/).

The admin server is a small HTTP service (default `127.0.0.1:3100`) that serves the dashboard, auth-protected management APIs, SSE streams, and optional public webhook entry points.

## Files

| File | Purpose |
| --- | --- |
| `startAdminServer.ts` | Bind/listen helper used by `src/index.ts` and tests. |
| `closeAdminServer.ts` | Graceful shutdown helper. |
| `router.ts` | Lightweight declarative micro-router (`Router.add()` / `Router.dispatch()` / `Router.match()`). Compiles `:param`-style patterns to anchored regexes, extracts and URL-decodes named parameters, and auto-returns 405 when a path matches but the HTTP method does not. Routes carry optional `RouteMeta` (`{ role?: UserRole }`); `defaultRoleForMethod()` is fail-closed — it maps **every** method (including GET/HEAD) to `operator`, so viewer access is opt-in (a route must explicitly declare `{ role: "viewer" }`), and `roleSatisfies()` compares role rank (`viewer < operator < admin`). |
| `adminServer.ts` | Auth gate (DB-backed session tokens, plus an open bootstrap mode while zero users exist), RBAC enforcement, security headers, and public endpoints (dashboard, health, img-proxy). Builds a single `Router` instance via `buildApiRouter()` at startup and dispatches every authenticated `/api/admin/*` request through it. Re-exports `getAuthContext` / `AuthContext`. |
| `adminAuthService.ts` | Password hashing (`scrypt`, `scrypt:N:r:p:salt:hash` format), session-token hashing (sha256), and `createAdminAuthService()` (login / validateSession with sliding 12-hour expiry / logout). Exports `SESSION_TTL_MS`, `AuthContext`. |
| `adminAuthRoutes.ts` | `/api/admin/auth/*` (setup-status, setup, login, logout, me) and `/api/admin/users/*` CRUD with last-admin guards, self password change, and audit logging. |
| `adminAudit.ts` | Shared audit-trail helper: `recordAudit(store, req, { action, targetType?, targetId?, details? })` resolves the actor from `getAuthContext(req)` (fallback `"unknown"`), masks secret-like detail keys via `maskAuditDetails()`, and appends fire-and-forget (never throws or blocks the response; no-ops when the store lacks `appendAuditEntry`). |
| `adminAuditRoutes.ts` | `GET /api/admin/audit` — admin-only, paginated audit-log read API. |
| `authContext.ts` | Per-request `AuthContext` storage (`WeakMap<IncomingMessage, AuthContext>`): `setAuthContext()` / `getAuthContext()`. |
| `adminRouteUtils.ts` | Shared HTTP primitives (`writeJson`, `writeHtml`, `readBody`, `toIsoTimestamp`, `asRecord`, `SECRET_MASK`). |
| `adminTaskRoutes.ts` | `/api/admin/tasks/*` list, detail, cycles, transitions, pause/resume/retry/abandon/delete. |
| `adminPromptRoutes.ts` | `/api/admin/prompts/*` CRUD + usage lookup. |
| `adminStreamRoutes.ts` | SSE endpoints: `/api/admin/logs/stream` (live agent logs) and `/api/admin/events/stream` (task polling). |
| `adminIntegrationRoutes.ts` | `/api/admin/integrations/*` CRUD, enable/disable, test, discover, models + `/api/admin/plugins` + `/api/admin/oauth-apps/*`. Integration config masking/merging/validation helpers. |
| `adminAgentsRoutes.ts` | `/api/admin/agents/*` CRUD + enable/disable + masking + `/api/admin/plugins/:type/oauth/*`. |
| `adminProjectsRoutes.ts` | `/api/admin/projects/*` CRUD, ticket/review target validation, remote skill-source validation/serialization, atomic push-target replacement, coding controls for Gerrit topic/ticket trailers/review links/CI retries, and automatic relaunch of FAILED/REVIEW_FAILED tasks on (re)configuration or re-enable. |
| `adminConcurrencyRoutes.ts` | `/api/admin/concurrency` read/update global concurrency. |
| `adminSettingsRoutes.ts` | `GET/PUT /api/admin/settings` — read/update editable runtime workflow settings (polling interval, max agent cycles, max retry attempts). Validates positive integers; delegates persistence + hot-apply to the `SettingsController` wired in `src/index.ts`. |
| `adminOverviewRoutes.ts` | `/api/admin/overview` dashboard stats/throughput/votes/runtime + `/api/admin/cost-summary` aggregated AI cost (per project & instance total, optional `?days=` period) + `/api/admin/model-usage` model distribution by run count & cost (global + per project, optional `?days=<n>` period filter). |
| `adminWebhookRoutes.ts` | Webhook management: secret rotation, allowed-IPs, webhook-info. |
| `dashboard.ts` | Serves the HTML shell for the Vite-built React SPA: reads the Vite manifest from `dist/admin-ui/.vite/manifest.json`, injects the hashed JS/CSS asset links plus a `window.__VE_ADMIN_BOOTSTRAP__` payload, and falls back to "Admin UI not built — run npm run build:ui" when the build output is missing. |
| `ui/` | Admin SPA source (React + TypeScript): `App.tsx`, `main.tsx`, `api.ts`, `states.ts`, `views/`, `components/`, `shell/`, `theme/`, `icons/`. Built with Vite (`vite.admin.config.ts`) into `dist/admin-ui`; `adminServer.ts` serves the hashed assets under `/admin-ui/*`. Commands: `npm run build:ui`, `npm run dev:ui` (watch), `npm run typecheck:ui`. |
| `assets/` | Static assets bundled with the admin server. |

The task live-log UI renders `skills.fetch_start`, `skills.fetch_complete`, and `skills.fetch_failed` payloads as human-readable skill fetch messages, including source repository, selected skills, and agent id when present.

The project form keeps remote skill-source validation on the normal save path. While that save is waiting on SSH checks, the primary action keeps showing `Saving…`; clicking it aborts the in-flight request and immediately starts a new save with the current SSH user/port/key/known-host field values. The modal also shows a persistent external skill-source check dashboard with each source URL, SSH user, SSH port, and per-source status (`checking`, `checked`, `failed`, `cancelled`, or `not checked`) so users can see what was attempted after a save error.

## Route surface

### Public routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` / `/admin` | Dashboard HTML shell. |
| `GET` | `/health` | Unauthenticated health check. |
| `POST` | `/webhooks/:integrationId/:event` | Mounted only when webhook deps are provided. Per-integration HMAC secret is the auth layer. Used by Redmine / GitLab; Gerrit review events use SSH `stream-events` instead. |
| `GET` | `/api/admin/auth/setup-status` | Unauthenticated. `{ needsSetup: boolean }` — true when the store supports users and zero users exist. |
| `POST` | `/api/admin/auth/login` | Unauthenticated. `{ username, password }` → `{ token, user }` session or 401. |

### Auth-protected routes

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/auth/setup` | Unauthenticated bootstrap: only valid while zero users exist (403 otherwise). Rate-limited (per-IP and per-username) alongside `/auth/login`. Creates the first `admin` user, logs them in, returns 201 `{ token, user }`, audits `auth.setup`. |
| `POST` | `/api/admin/auth/logout` | Revokes the presented session token (204). |
| `GET` | `/api/admin/auth/me` | Current auth context `{ id, username, role }`. |
| `GET` / `POST` | `/api/admin/users` | List / create users (admin only). Duplicate username → 409. |
| `PUT` | `/api/admin/users/:id` | Update role/enabled (admin only). Demoting or disabling the last enabled admin → 409; disabling revokes the user's sessions. |
| `PUT` | `/api/admin/users/:id/password` | Admins reset anyone; non-admins change their own with a verified `currentPassword` (403 otherwise). Revokes the target's sessions; audits `user.password_change`. |
| `DELETE` | `/api/admin/users/:id` | Delete user (admin only); deleting the last enabled admin → 409. |
| `GET` | `/api/admin/audit` | Audit-log read API (admin only). Query params: `limit` (default 50, cap 200), `offset`, `action` (exact match), `actor` (exact `actorName` match). Returns `{ entries, total, limit, offset }`; entries carry `id`, `actorUserId`, `actorName`, `action`, `targetType`, `targetId`, `details`, ISO `createdAt`, newest first. 501 when the store lacks `listAuditEntries`. |
| `GET` | `/api/admin/status` | Runtime status and provider summary. |
| `GET` | `/api/admin/config` | Sanitized runtime config view. |
| `GET` | `/api/admin/providers` | Provider summaries, one entry per active integration plus the runtime admin API card. |
| `GET` | `/api/admin/plugins` | Registered plugin descriptors, including field metadata, derived capabilities, and optional OAuth metadata used by the dashboard. |
| `POST` | `/api/admin/plugins/:type/oauth/device-code` | Start a descriptor-driven device flow for integrations whose descriptor exposes `oauth.mode = device` plus `createOAuthHandler`. |
| `POST` | `/api/admin/plugins/:type/oauth/token` | Complete the descriptor-driven device flow and return `{ encryptedToken, isPlaintext }`. |
| `POST` | `/api/admin/plugins/:type/oauth/start` | Start a descriptor-driven redirect flow for integrations whose descriptor exposes `oauth.mode = redirect`; request body must include `redirectUri`, may include a client-generated `state`, optional PKCE `codeChallenge` / `codeChallengeMethod`, and may include visible draft config plus `integrationId` so masked stored secrets can be restored during edit flows. |
| `POST` | `/api/admin/plugins/:type/oauth/complete` | Complete the descriptor-driven redirect flow from `{ code, redirectUri, state?, codeVerifier? }` and return `{ encryptedToken, isPlaintext }`; accepts the same optional `config` / `integrationId` merge inputs as `start`. |
| `GET` | `/api/admin/oauth-apps` | List the admin-managed OAuth app registry used for URL-only connect flows (e.g. GitLab). |
| `POST` | `/api/admin/oauth-apps` | Create or update an OAuth app registry entry from `{ provider, baseUrl, clientId }`. |
| `DELETE` | `/api/admin/oauth-apps` | Delete an OAuth app registry entry from `{ provider, baseUrl }`. |
| `POST` | `/api/admin/oauth-apps/resolve` | Resolve a provider + base URL to the matching `{ baseUrl, clientId }` registry entry for the dashboard OAuth flow. |
| `GET` | `/api/admin/logs/stream` | SSE server logs. |
| `GET` | `/api/admin/events/stream` | SSE agent-task events. |
| `GET` | `/api/admin/tasks` | Task list. |
| `GET` | `/api/admin/tasks/:id` | Task detail. |
| `GET` | `/api/admin/tasks/:id/cycles` | Stored agent cycles. |
| `GET` | `/api/admin/tasks/:id/transitions` | Transition history. |
| `PATCH` | `/api/admin/tasks/:id/pause` | Writes a metadata-only pause row. |
| `PATCH` | `/api/admin/tasks/:id/resume` | Writes a metadata-only resume row. |
| `POST` | `/api/admin/tasks/:id/retry` | Retry task. |
| `POST` | `/api/admin/tasks/:id/abandon` | Abandon task. |
| `GET` | `/api/admin/prompts` | List prompts. |
| `POST` | `/api/admin/prompts` | Create custom prompt. |
| `PUT` | `/api/admin/prompts/:id` | Update prompt. |
| `DELETE` | `/api/admin/prompts/:id` | Delete prompt (`system` / `instructions` are protected). |
| `GET` | `/api/admin/integrations` | List integrations with masked secrets. Each row exposes `provider`, derived `capabilities`, and `domainCapabilities` (no `type` / `category`) for capability-driven dashboard selectors. Legacy GitLab rows created before `authMode` existed are serialized back to the dashboard as `authMode = "pat"` for edit-form compatibility. |
| `GET` | `/api/admin/integrations/by-category` | Grouped integration view used by the dashboard; groups are now keyed by **domain capability** (resolved from each provider descriptor). |
| `POST` | `/api/admin/integrations` | Create integration. OAuth-backed providers can be created as drafts with no token; the dashboard writes the hidden OAuth token field only after the configured OAuth flow completes. |
| `GET` | `/api/admin/integrations/:id` | Integration detail. |
| `PUT` | `/api/admin/integrations/:id` | Update integration; omitted/masked secrets are restored from the stored row. A changed config clears the discovery cache so stale repos/projects are re-fetched on next discover. |
| `DELETE` | `/api/admin/integrations/:id` | Delete integration. |
| `POST` | `/api/admin/integrations/test` | Validate unsaved integration config. |
| `POST` | `/api/admin/integrations/:id/test` | Validate saved integration config. |
| `POST` | `/api/admin/integrations/:id/discover` | Refresh discovery cache (repos, projects, models, etc.). GitHub repo discovery is token-centric (`/user/repos`, filtered to the configured owner) so only repos the token can actually access are listed. |
| `GET` | `/api/admin/integrations/:id/branches?repoKey=…` | On-demand branch discovery for one repository (used by the project push-target / review forms). Requires a `repoKey` query param (URL-encoded, may contain `/`). Resolves the provider descriptor's `discoverBranches` hook (Gerrit / GitLab / GitHub); decrypts password config fields before invoking it. `400` when `repoKey` is missing or the provider has no `discoverBranches`, `404` for unknown integrations, `502` on upstream failure. Not cached. |
| `GET` | `/api/admin/integrations/:id/models` | Return cached discovered models. |
| `PATCH` | `/api/admin/integrations/:id/enable` | Enable integration. |
| `PATCH` | `/api/admin/integrations/:id/disable` | Disable integration. |
| `GET` | `/api/admin/integrations/:id/webhook-info` | Render URL template + supported events + secret status. |
| `POST` | `/api/admin/integrations/:id/webhook-secret/rotate` | Generate and persist a new webhook secret. |
| `GET` | `/api/admin/integrations/:id/webhook-allowed-ips` | Read allowed IP list. |
| `PUT` | `/api/admin/integrations/:id/webhook-allowed-ips` | Replace allowed IP list. |
| `POST` | `/api/admin/ssh-key/generate` | Stateless SSH key-pair generation (`{ provider }` → `{ sshPrivateKeyEnc, sshPublicKey }`) for any provider whose descriptor implements `generateSshKeyPair` (see `src/utils/sshKeyGen.ts`). Used by the in-form "Generate key" flow before the integration is saved; nothing is persisted. `400` when the provider is unknown/unsupported or `ADMIN_AUTH_SECRET` is unset (generated keys must always be stored encrypted). |
| `POST` | `/api/admin/integrations/:id/ssh-key/generate` | Generate a new key pair and persist it onto an existing integration's config (`sshPrivateKeyEnc` + `sshPublicKey`), returning `{ publicKey }`. Same `400` cases as above; `404` for unknown integrations. |
| `GET` | `/api/admin/integrations/:id/ssh-key/public` | Return the currently stored public key (if any) for display/copy in the dashboard. |
| `GET` | `/api/admin/ssh-agent/keys` | List public keys currently loaded in the host's `ssh-agent` (via `ssh-add -L`), used by the "SSH Agent" auth mode's key picker. Returns `{ keys: [], agentAvailable: false }` when no agent socket is reachable or the agent has no identities loaded — never a 5xx, so the UI can render an actionable empty state. |
| `GET` | `/api/admin/agents` | Agent library list. |
| `POST` | `/api/admin/agents` | Create agent record. |
| `GET` | `/api/admin/agents/:id` | Agent detail with masked secrets. |
| `PUT` | `/api/admin/agents/:id` | Update agent. |
| `DELETE` | `/api/admin/agents/:id` | Delete agent; returns `409` when referenced by projects. |
| `PATCH` | `/api/admin/agents/:id/enable` | Enable agent. |
| `PATCH` | `/api/admin/agents/:id/disable` | Disable agent. |
| `GET` | `/api/admin/projects` | Project list with resolved agent/integration names. |
| `POST` | `/api/admin/projects` | Create coding or review project. Supports `skillDiscoveryEnabled` for local repository skills and `skillSources` (`{ source, skills, installAll?, sshUser?, sshPort?, sshKeyPath?, sshKnownHostsPath? }`) for project-approved remote skills. The admin UI preloads a new-project row for `ssh://g1.sfl.io/sfl/agent-skills` with `sshPort: 29419` and `installAll: true`; API clients that omit `skillSources` persist an empty list, and explicit `skillSources: []` remains empty. Remote sources are used whenever configured, independent of `skillDiscoveryEnabled`. SSH skill sources are checked with a bounded `ssh -T` connection test before saving; failures return 400 with the source index, URL, and SSH stderr/exit details. Coding payloads may also set `gerritTopicOverride`, `useFullTicketUrlInCommits`, `postReviewLinkToTicket`, and `reactToCiFailures` (all optional/off by default). Orphaned `FAILED`/`REVIEW_FAILED` tasks adopted via the new ticket-source binding are relaunched automatically, unless the project is created disabled. |
| `POST` | `/api/admin/projects/skill-sources/list` | Runs `npx skills add -l <source>` with optional SSH hints to list available skills before saving a new project source row; requires unscoped `project.write`. |
| `POST` | `/api/admin/projects/:id/skill-sources/list` | Same remote skill listing flow for an existing project, scoped through `resourceParam: "id"` so project editors with project-level `project.write` can use it. |
| `GET` | `/api/admin/projects/:id` | Project detail. |
| `PUT` | `/api/admin/projects/:id` | Update project, including the optional Gerrit topic/ticket trailer/review-link/CI-retry controls; coding-project `pushTargets` replace atomically. When remote skill sources are replaced, SSH sources are checked with the same bounded `ssh -T` validation used on create and the update is rejected as 400 if any source is unreachable. When ticket source, push targets, review config, agent binding/override, post-clone script, skill-discovery toggle, or remote skill sources change, or the project is enabled, every `FAILED`/`REVIEW_FAILED` task bound to the project is relaunched automatically (no manual retry click needed). |
| `DELETE` | `/api/admin/projects/:id` | Delete project and linked child rows. |
| `PATCH` | `/api/admin/projects/:id/enable` | Enable project. If it was previously disabled, its `FAILED`/`REVIEW_FAILED` tasks are relaunched automatically. |
| `PATCH` | `/api/admin/projects/:id/disable` | Disable project. |
| `GET` / `PUT` | `/api/admin/concurrency` | Read/update global concurrency plus live in-memory snapshot. `PUT` accepts `{ global: number \| null }` (numeric strings are coerced server-side). |
| `GET` / `PUT` | `/api/admin/settings` | Read/update editable runtime workflow settings. `PUT` accepts any subset of `{ pollingIntervalMs, maxAgentCycles, maxRetryAttempts }` (positive integers; interval in ms). Persists to `app_settings` and hot-applies to the polling loop, orchestrator, and admin runtime config. |
| `GET` | `/api/admin/overview` | Dashboard summary: task stats, throughput sparkline, review-vote breakdown, runtime facts. |
| `GET` | `/api/admin/cost-summary` | Aggregated AI execution cost: instance total + per-project breakdown (USD / AI credits / runs). Optional `?days=<n>` scopes to a trailing period (omitted = all-time). Legacy cycles without a cost snapshot are recomputed from their event log so historical runs are still counted. |
| `GET` | `/api/admin/model-usage` | Model usage distribution by run count and cost (global `byModel` + `perProject`). Optional `?days=<n>` trailing-period filter; legacy cycles without a recorded model snapshot are recomputed from `agent_events`. |
| `GET` | `/api/admin/permissions` | PBAC permission catalog (all valid `"<resourceType>.<action>"` strings) for policy-editor dropdowns. Requires `policy.manage`. |
| `GET` / `POST` | `/api/admin/groups` | List / create user groups (`policy.manage`). |
| `GET` / `PUT` / `DELETE` | `/api/admin/groups/:id` | Group detail (with members) / rename / delete. |
| `POST` | `/api/admin/groups/:id/members` | Add a user (`{ userId }`) to the group. |
| `DELETE` | `/api/admin/groups/:id/members/:userId` | Remove a user from the group. |
| `GET` / `POST` | `/api/admin/policies` | List (with rule/binding counts) / create policies (`policy.manage`). |
| `GET` / `PUT` / `DELETE` | `/api/admin/policies/:id` | Policy detail (rules + bindings) / rename / delete. Built-in policies return `409` on `PUT`/`DELETE`. |
| `PUT` | `/api/admin/policies/:id/rules` | Replace the policy's rule set (`{ rules: [{ permission, resourceId? }] }`); unknown permissions → `400`; built-in → `409`. |
| `POST` | `/api/admin/policies/:id/bindings` | Bind the policy to a principal (`{ principalType: "user"\|"group", principalId }`); duplicate → `409`, unknown principal → `404`. |
| `DELETE` | `/api/admin/policies/:id/bindings/:principalType/:principalId` | Remove a binding. |

## Authentication

Two auth modes share the same route surface:

- **Bootstrap (zero users)**: while no users exist yet, every `/api/admin/*` route is open with an implicit `admin`-role context (`{ userId: null, username: "bootstrap" }`) set in `adminServer.ts`. There is no token or secret involved in this mode — `ADMIN_AUTH_SECRET` is unrelated to auth; it is only used for OAuth token encryption at rest. `POST /api/admin/auth/setup` is the only route that matters here: it enforces that zero users exist, creates the first `admin` user, and logs them in. Stores without the user-store API (feature-detected via `countUsers`) stay in this open bootstrap mode permanently.
- **DB sessions (≥1 user)**: once a user exists, `/api/admin/*` requires a Bearer session token from `POST /api/admin/auth/login` (opaque 64-hex token; sha256 hash stored in `user_sessions`; sliding 12-hour expiry, touch throttled to once per minute; the short window is XSS defense-in-depth since the SPA holds the token in sessionStorage). `POST /api/admin/auth/setup` then always returns 403.
- **Brute-force protection**: `/api/admin/auth/login` and `/api/admin/auth/setup` share an in-memory rate limiter (`loginRateLimiter.ts`) keyed by client IP and by (normalized) username. After 5 failures in a 15-minute window the key is locked out with exponential backoff (30s doubling up to a 15-minute cap); requests during a lockout get 429 with `Retry-After`. Failed logins are also recorded in the audit log (`auth.login_failed`, no secrets).
- **Username normalization**: usernames are normalized (Unicode NFC, trimmed, lower-cased) on both creation and login, so e.g. `Alice` and `alice` are always the same account.
- **Password policy**: passwords must be ≥ 8 characters and are checked against a curated common-password denylist (`commonPasswords.ts`); this applies to `POST /api/admin/auth/setup`, user creation, and password changes.

**Authorization is pure PBAC** — every routed request is authorized solely by the route's declared permission; there is **no role fallback**. Roles still exist, but only as (a) the `admin` **superuser** short-circuit, (b) the selector for a new user's default policy bundle (`Operator`/`Viewer`) at creation, and (c) a stored attribute. They are never consulted by the gate.

Each non-public route declares exactly one authorization mode in its `RouteMeta`:

- `permission` — a `"<resourceType>.<action>"` string (catalog in `src/admin/authorization/permissions.ts`). Optional `resourceParam` scopes the check to a path-parameter resource id; `collection: true` marks a list route.
- `authenticated: true` — any logged-in user may reach it (auth-self routes: `GET /auth/me`, `POST /auth/logout`, own password change `PUT /users/:id/password`).
- neither — reachable only by the superuser (fail-closed safety net for unannotated routes).

The gate resolves each request's **effective permissions** once (cached via `setEffectivePermissions`): the `admin` role and bootstrap are superusers; every other user's grants are the union of rules from policies bound directly to them and to their groups (`getEffectivePolicyRulesForUser` → `buildEffectivePermissions`; empty grants = deny-all when PBAC is unavailable). Enforcement (`src/admin/authorization/policyEngine.ts`):

- **Scoped route** (`resourceParam` set): `can(perms, permission, resourceId)` — a `*` (all-resources) grant or a grant whose id set contains `resourceId` passes. `task.*` permissions resolve the owning **project** id (tasks inherit their project's scope).
- **Global route** (no `resourceParam`): requires a `*` grant.
- **Collection route** (`collection: true`): passes when the caller has the permission on **any** resource; the handler then scope-filters the response (e.g. `GET /api/admin/projects` returns only readable projects).

Insufficient permission → 403 `{ error: "forbidden", permission }`. The per-request identity is available to handlers via `getAuthContext(request)`, and `GET /api/admin/auth/me` returns the caller's serialized `capabilities` for client-side gating.

**Only `project.*` and `task.*` are scopeable** (task rules scope by the owning project's id, resolved in the gate); integrations, agents and prompts are shared, library-style resources whose permissions are global (all-or-nothing). The policy API rejects a non-null `resourceId` on any global permission (`isScopeablePermission`).

**Route → permission map** (representative): overview/status/config/cost/model-usage → `overview.read`; settings → `system.read`/`system.write`; concurrency → `concurrency.read`; providers/plugins/integrations/models/branches/ssh → `integration.read`, integration create/update/test/ssh-gen → `integration.write`, delete → `integration.delete`, enable/disable/discover → `integration.operate`; oauth-apps + plugin OAuth → `oauth.manage`; agents → `agent.read`/`agent.write`/`agent.delete`/`agent.operate`; prompts → `prompt.read`/`prompt.write`/`prompt.delete`; tasks read/streams → `task.read`, pause/resume/retry/abandon → `task.operate`, delete → `task.delete` (all scoped to the task's project); projects → `project.read`/`project.write`/`project.delete`/`project.operate` (resource-scoped, list-filtered); users → `user.manage`; audit → `audit.read`; groups/policies/permissions → `policy.manage`.

**Built-in policies** reproduce the former roles: the seeded `Operator` policy grants every non-administrative permission (project/task/integration/agent/prompt/oauth/overview/concurrency/system); `Viewer` grants `overview.read`, `system.read`, `concurrency.read`, `project.read`, `task.read`. Both are `builtin = 1` and protected from edit/delete. New `operator`/`viewer` users are auto-bound to the matching policy on creation (role = default access bundle) which an admin can then narrow (e.g. replace with a project-scoped policy).

The GitLab img-proxy `?t=` query token accepts a session token when users exist; in bootstrap mode (no users yet) the proxy is open, matching every other route.

## Audit trail

All mutating admin routes append an `audit_log` row after a successful mutation via the shared `recordAudit()` helper ([adminAudit.ts](../../../src/admin/adminAudit.ts)):

- **Actor** comes from `getAuthContext(req)` (`actorUserId` + `actorName`; bootstrap mode records `"bootstrap"`, missing context falls back to `"unknown"`).
- **Details masking**: `maskAuditDetails()` recursively replaces values whose key contains a secret pattern (`token`, `secret`, `password`, `passwd`, `pwd`, `credential`, `key` — case-insensitive substring) with `"***"`. Matching is a deliberately fail-safe substring test (mirrors `SECRET_KEY_PATTERNS` in `adminAgentsRoutes.ts`) so separator-less compounds like `apikey` / `accesstoken` are still masked; the trade-off is that benign words containing a pattern may be over-masked. An explicit safe-key allowlist (`repoKey`, `repoKeys`, `ticketProjectKey`, `publicKey`) and any key ending in `Path` (e.g. `sshKeyPath`, a filesystem path) are never masked. Cyclic object graphs are detected (`WeakSet` of visited objects) and resolve to `"[Circular]"` instead of recursing forever. Secrets are never written to the audit log.
- **Fire-and-forget with retry**: appends run in the background and never block or fail the API response. Transient append failures are retried with backoff (`appendAuditWithRetry`, delays 100ms/500ms/2s); after the final attempt the failure is logged at error level with the attempt count for monitoring. Stores without `appendAuditEntry` (feature-detected) are silently skipped, keeping mock-store tests working.

Recorded actions:

| Area | Actions |
| --- | --- |
| Auth / users | `auth.setup`, `user.create`, `user.update`, `user.password_change`, `user.delete` |
| Integrations | `integration.create`, `integration.update`, `integration.delete`, `integration.enable`, `integration.disable`, `integration.discover` |
| OAuth apps / plugins | `oauth_app.create`, `oauth_app.delete`, `plugin.oauth` |
| Webhooks | `webhook.secret_rotate`, `webhook.allowed_ips_update` |
| Agents | `agent.create`, `agent.update`, `agent.delete`, `agent.enable`, `agent.disable` |
| Projects | `project.create`, `project.update`, `project.delete`, `project.enable`, `project.disable`, `project.ticket_source_set`, `project.push_targets_set`, `project.agent_assign` (the `_set`/`assign` sub-actions are emitted from `PUT /api/admin/projects/:id` when the corresponding payload fields are present) |
| Prompts | `prompt.create`, `prompt.update`, `prompt.delete` |
| Tasks | `task.delete`, `task.pause`, `task.resume`, `task.retry`, `task.abandon` |
| Groups / Policies (PBAC) | `group.create`, `group.update`, `group.delete`, `group.member_add`, `group.member_remove`, `policy.create`, `policy.update`, `policy.delete`, `policy.rules_set`, `policy.binding_add`, `policy.binding_remove` |

The log is readable through `GET /api/admin/audit` (admin only, see the endpoints table) and browsed in the SPA via the admin-only **Audit** tab in Configuration.

The dashboard stores the session token client-side (sessionStorage `ve-admin-token`) and sends it through the `Authorization` header.

## Secret masking

The admin server never returns plaintext password-like fields. On `PUT`, values equal to `"********"`, empty strings, or omitted properties are merged from the stored row before validation so partial edits do not erase secrets.

## Dashboard behavior

[dashboard.ts](../../../src/admin/dashboard.ts) serves the shell for the Vite-built React SPA whose source lives in [src/admin/ui/](../../../src/admin/ui/); all client logic lives in the SPA, not inline in the shell.

**Login / setup flow (SPA)**: on load, the auth screen (`shell/AuthScreen.tsx`) calls the public `GET /api/admin/auth/setup-status`. When `needsSetup` is true it renders a “Create first admin” form (username + password ≥ 8, not a common password, + confirm) that POSTs directly to `/api/admin/auth/setup` — unauthenticated bootstrap, no secret or derived token is involved — which returns a session token. Otherwise it renders a username/password login form backed by `POST /api/admin/auth/login`. The session token is kept in sessionStorage (`ve-admin-token`) and sent as a Bearer header on all API/SSE calls (plus the `?t=` query token for the log stream). `ui/api.ts` centralizes 401 handling: any 401 clears the token and fires an `onUnauthorized` callback that drops the app back to the login screen; 403 (insufficient role) never logs out — it surfaces as a normal error message.

**Role-aware UI**: after auth, `App.tsx` loads `GET /api/admin/auth/me` and provides `{ user, isAdmin, canOperate }` through `ui/authContext.tsx` (`useCurrentUser()` hook; `canOperate` = role ≠ viewer). The top bar shows the username, a role badge, a change-password button (self password change via `PUT /api/admin/users/:id/password` with `currentPassword`; on success the user is told sessions were revoked and is routed back to login), and Logout (`POST /api/admin/auth/logout`). Nav + data loading are role-gated:
- **viewer** sees **only** the Overview and Tasks top-level views — the Configuration nav entry is hidden (`TopBar` filters it on `canOperate`) and a deep link to `#config*` falls back to Overview (`App.tsx` `effectiveView`). `loadAll()` only fetches the viewer-safe endpoints (tasks/status/config/overview) and skips all config-area + providers requests so a viewer never triggers a now-forbidden call.
- **operator** gets the full Configuration area, **including** the Integrations and OAuth Apps panels (add/edit/delete/enable/disable/test/discover, OAuth-app registration, plugin OAuth flows) — these are gated on `canOperate`, not `isAdmin`.
- **admin** additionally sees the Users and Audit tabs (gated on `isAdmin`).

**Password fields**: every password `<input>` (login + first-admin setup password/confirm in `shell/AuthScreen.tsx`, current/new/confirm in `shell/ChangePasswordModal.tsx`, create-user + reset-password in `views/ConfigView/UsersSection.tsx`) uses the reusable `components/PasswordField.tsx`, which renders an inline eye button (accessible `aria-label` “Show password” / “Hide password”) that toggles the input between `password` and `text`. It matches the native input styling (defaults to `FieldInput`; accepts a `style` override for the mono login form) and uses the `eye` / `eye-off` icons.

**Users tab (admin only)**: Configuration → Users lists accounts (username, role badge, enabled toggle, created date), with a create-user modal (username/password/role), inline role select, reset-password modal, and delete-with-confirm. Server-side 409s (duplicate username, last-admin guard) surface as inline error banners.

**Audit tab (admin only)**: Configuration → Audit renders the paginated audit table (local time, actor, action tag, target type/id, expandable pretty-printed details JSON) with debounced action/actor filter inputs and Newer/Older paging over `GET /api/admin/audit?limit&offset&action&actor`.

- The configuration UI validates unsaved integration state through `POST /api/admin/integrations/test`.
- The Providers view renders one card per active integration rather than collapsing everything into a single card per provider type.
- Integration forms are descriptor-driven. The add-integration modal picks a **provider** (not a role) and filters available providers by descriptor domain capabilities. Saved integrations are grouped into a single provider-grouped **Integrations** section with capability badges (`renderCapabilityBadges` over `domainCapabilities`); the former type-centric Tickets / Code Review / Agents nav sections were collapsed away.
- Integration forms collect both regular inputs and descriptor-backed `select` fields, but only when those controls are currently visible. Fields hidden behind `dependsOn` are skipped during test/save payload generation, which is required for safe OAuth/PAT fallback UX.
- When a descriptor exposes OAuth metadata, the dashboard renders a provider auth section without hardcoding the integration type and dispatches by `oauth.mode`. Device flows still render the code-entry panel, while redirect flows collect the currently visible config fields, generate a client-side `state` plus PKCE `codeVerifier`/`codeChallenge`, and may resolve additional provider config before calling `startPath`. GitLab uses that hook to look up the matching OAuth app client id from `/api/admin/oauth-apps/resolve`, so user-facing GitLab integration forms only need the base URL plus runtime token state. The popup then returns to the admin origin and finishes through `completePath` with the same `redirectUri` only if the returned `state` matches. When editing an existing integration, the server restores masked stored secrets before creating the provider handler, so operators do not need to retype unchanged hidden credentials just to reconnect. OAuth sections can themselves be gated by `dependsOn`, so a future `authMode = oauth | pat` selector can hide or reveal them cleanly. Copilot currently uses the device path for GitHub auth and stores the hidden `sessionToken` field only after the flow completes.
- GitLab Add Integration forms are now provider-scoped only: they no longer ask for GitLab project IDs or GitLab workflow label settings. For coding projects, the GitLab issue project is selected in the Project modal's Ticket Source section; for GitLab MR/VCS flows, the target GitLab project comes from the selected repository entries in the Project modal.
- Configuration now includes a dedicated `GitLab OAuth` section where admins manage the GitLab OAuth app registry (`baseUrl -> clientId`) used by the URL-only GitLab connect flow.
- The GitLab image proxy (`GET /api/admin/img-proxy`) now uses the same Bearer token contract as the main GitLab connectors, so OAuth-backed GitLab integrations can still render proxied GitLab-hosted assets in the admin UI.
- Successful Copilot tests and discovery refreshes populate cached model choices that the Agents UI reads via `/api/admin/integrations/:id/models`.
- Stream-capable integration details surface live runtime state (connection state, last event, reconnect count, last error) whenever the descriptor exposes `streamEvents`; Gerrit is the current implementation.
- Agent and project modals filter persisted integrations by derived `domainCapabilities`. Coding projects choose ticket sources from `issue_tracking` integrations and push targets from `source_control` integrations, while review projects choose review targets from `code_review` integrations. Project summaries serialize each bound integration as `{ id, name, provider, domainCapabilities }`.
- Project review-repository selection is discovery-driven and now includes client-side search plus `Select all` / `Unselect all` actions on the currently visible repository subset.
- Projects can now be edited from both the Projects list row action and the Project detail drawer. The edit flow loads `/api/admin/projects/:id`, pre-fills project-specific fields, and persists changes through `PUT /api/admin/projects/:id`.
- Coding project forms expose optional controls for a literal Gerrit topic, full ticket URL commit trailers, posting first-cycle review links to the ticket, and reacting to CI failures; existing projects keep all four behaviors disabled unless explicitly enabled.
- Prompts are managed under Configuration rather than a separate top-level page.
- The Tasks view streams live agent events backed by `agent_cycles.agent_events` and the in-memory event bus; log filters are `All`, `Tools`, `Usage`, `Errors`.
- Live log ingestion de-duplicates overlapping SSE replay sources (persisted cycle history, in-memory task buffer, and reconnect replays) so reconnects do not render duplicate rows.
- Live log rows render structured `data` payloads as formatted JSON blocks (instead of single-line raw serialization) when the payload is object/array-shaped.
- Task rows and task details expose a single primary ticket/review link on the source identifier; detail headers avoid duplicate secondary link controls, while per-repository review links are still shown from `changesPerRepo` when available.
- Task detail footer badges now show compact task/review identifiers (`displayId` / `gerritChangeId`) instead of full internal task ids.
- Task origin badges in the Tasks list/details abbreviate GitHub pull-request sources as `GITHUB-PR` (instead of `GITHUB-PULL-REQUEST`) for compact readability.
- Top-bar and overview provider counters are integration-driven (enabled integrations), avoiding the extra runtime-provider card count used by `/api/admin/providers`.
- Overview throughput labeling now includes the dynamic polling window (`last N ticks (~Xm)`), derived from the current polling interval.
- System Settings is an **editable** form: polling interval (seconds), max agent cycles, and max retry attempts can be changed and saved (`PUT /api/admin/settings`), applied immediately without restart. Polling state, environment, and log level remain read-only runtime facts below the form.
- Desktop drawers use a push layout that shifts the main app left so the right drawer does not cover the working content area.

The supported server-side model is `projects` / `project_*`. There are no `/api/admin/repository-sets` routes.

## Tests

- `tests/unit/adminServer.test.ts`
- `tests/unit/adminServer.behavior.test.ts`
- `tests/unit/adminServer.integration.test.ts`
- `tests/unit/adminHealthEndpoint.test.ts`
- `tests/unit/adminPluginRoutes.test.ts`
- `tests/unit/adminPromptRoutes.test.ts`
- `tests/unit/adminIntegrationsDiscover.test.ts`
- `tests/unit/adminWebhookSecretRoutes.test.ts`
- `tests/unit/adminConcurrencyRoutes.test.ts`
- `tests/unit/adminAgentsRoutes.test.ts`
- `tests/unit/adminProjectsRoutes.test.ts`
- `tests/unit/closeAdminServer.test.ts`
- `tests/unit/adminCostRoutes.test.ts`
- `tests/unit/adminProjectsRoutes.relaunch.test.ts`
- `tests/unit/adminAuthService.test.ts`
- `tests/unit/adminAuthRoutes.test.ts`
- `tests/unit/adminServerRbac.test.ts`
- `tests/unit/adminAudit.test.ts`
- `tests/unit/adminAuditRoutes.test.ts`
- `tests/unit/dashboard.test.ts`
- `tests/unit/dashboard.configurationTab.test.ts`
