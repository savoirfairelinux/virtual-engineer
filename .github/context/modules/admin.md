# Modules — Admin Server

**Source:** [src/admin/](../../../src/admin/).

The admin server is a small HTTP service (default `127.0.0.1:3100`) that serves the dashboard, auth-protected management APIs, SSE streams, and optional public webhook entry points.

## Files

| File | Purpose |
| --- | --- |
| `startAdminServer.ts` | Bind/listen helper used by `src/index.ts` and tests. |
| `closeAdminServer.ts` | Graceful shutdown helper. |
| `router.ts` | Lightweight declarative micro-router (`Router.add()` / `Router.dispatch()` / `Router.match()`). Compiles `:param`-style patterns to anchored regexes, extracts and URL-decodes named parameters, and auto-returns 405 when a path matches but the HTTP method does not. Routes carry a `RouteMeta` authorization declaration used by the **pure-PBAC** gate: `permission` (a `"<resourceType>.<action>"` string, optional `resourceParam` for resource scoping / `collection` for list routes), or `authenticated: true` for auth-self routes. There is **no** role fallback — see the Authentication section. |
| `adminServer.ts` | Auth gate (DB-backed session tokens, plus an open bootstrap mode while zero users exist), RBAC enforcement, security headers, and public endpoints (dashboard, health, img-proxy). Builds a single `Router` instance via `buildApiRouter()` at startup and dispatches every authenticated `/api/admin/*` request through it. Re-exports `getAuthContext` / `AuthContext`. |
| `adminAuthService.ts` | Password hashing (`scrypt`, `scrypt:N:r:p:salt:hash` format), session-token hashing (sha256), and `createAdminAuthService()` (login / validateSession with sliding 12-hour expiry / logout). Exports `SESSION_TTL_MS`, `AuthContext`. |
| `adminAuthRoutes.ts` | `/api/admin/auth/*` (setup-status, setup, login, logout, me) and `/api/admin/users/*` CRUD with last-admin guards, self password change, and audit logging. |
| `adminAudit.ts` | Shared audit-trail helper: `recordAudit(store, req, { action, targetType?, targetId?, details? })` resolves the actor from `getAuthContext(req)` (fallback `"unknown"`), masks secret-like detail keys via `maskAuditDetails()`, and appends fire-and-forget (never throws or blocks the response; no-ops when the store lacks `appendAuditEntry`). |
| `adminAuditRoutes.ts` | `GET /api/admin/audit` — admin-only, paginated audit-log read API. |
| `authContext.ts` | Per-request `AuthContext` storage (`WeakMap<IncomingMessage, AuthContext>`): `setAuthContext()` / `getAuthContext()`. |
| `adminRouteUtils.ts` | Shared HTTP primitives (`writeJson`, `writeHtml`, `readBody`, `toIsoTimestamp`, `asRecord`, `SECRET_MASK`). |
| `adminTaskRoutes.ts` | `/api/admin/tasks/*` list, detail, cycles, transitions, pause/resume/retry/abandon/delete. |
| `adminPromptRoutes.ts` | `/api/admin/prompts/*` CRUD + usage lookup. |
| `adminStreamRoutes.ts` | SSE endpoints: `/api/admin/logs/stream` (task-scoped live agent logs; requires `taskId`) and `/api/admin/events/stream` (task polling). |
| `adminIntegrationRoutes.ts` | `/api/admin/integrations/*` CRUD, enable/disable, test, discover, models + `/api/admin/plugins` + `/api/admin/oauth-apps/*`. Integration config masking/merging/validation helpers. |
| `adminAgentsRoutes.ts` | `/api/admin/agents/*` CRUD + enable/disable + masking + `/api/admin/plugins/:type/oauth/*`. |
| `adminProjectsRoutes.ts` | `/api/admin/projects/*` CRUD, ticket/review target validation, remote skill-source validation/serialization, atomic push-target replacement, coding controls for Gerrit topic/ticket trailers/review links/CI retries, and automatic relaunch of FAILED/REVIEW_FAILED tasks on (re)configuration or re-enable. |
| `adminConcurrencyRoutes.ts` | `GET /api/admin/concurrency` — read-only live in-memory run-slot snapshot (`{ global, perProject, perAgent }`); 501 when no tracker is wired. |
| `adminPoliciesRoutes.ts` | PBAC management: `/api/admin/permissions` catalog, `/api/admin/groups` (+members), `/api/admin/policies` (+`/rules`, `/bindings`). All gated by `policy.manage`. |
| `adminSettingsRoutes.ts` | `GET/PUT /api/admin/settings` — read/update editable runtime workflow settings (polling interval, max agent cycles, max retry attempts). Validates positive integers; delegates persistence + hot-apply to the `SettingsController` wired in `src/index.ts`. |
| `adminOverviewRoutes.ts` | `/api/admin/overview` dashboard stats/throughput/votes/runtime + `/api/admin/cost-summary` aggregated AI cost (per project & instance total, optional `?days=` period) + `/api/admin/model-usage` model distribution by run count & cost (global + per project, optional `?days=<n>` period filter). |
| `adminWebhookRoutes.ts` | Webhook management: secret rotation, allowed-IPs, webhook-info. |
| `dashboard.ts` | Serves the HTML shell for the Vite-built React SPA: reads the Vite manifest from `dist/admin-ui/.vite/manifest.json`, injects the hashed JS/CSS asset links plus a `window.__VE_ADMIN_BOOTSTRAP__` payload, and falls back to "Admin UI not built — run npm run build:ui" when the build output is missing. |
| `providerSummary.ts` | Builds the `AdminProviderSummary[]` list shown in the admin UI's provider panel. Extracted from `src/index.ts`; exposes `buildAdminProviderSummaries(config, pluginManager?)`. |
| `ui/` | Admin SPA source (React + TypeScript): `App.tsx`, `main.tsx`, `api.ts`, `states.ts`, `views/`, `components/`, `shell/`, `theme/`, `icons/`. Built with Vite (`vite.admin.config.ts`) into `dist/admin-ui`; `adminServer.ts` serves the hashed assets under `/admin-ui/*`. Commands: `npm run build:ui`, `npm run dev:ui` (watch), `npm run typecheck:ui`. |
| `assets/` | Static assets bundled with the admin server. |

The task live-log UI renders `skills.fetch_start`, `skills.fetch_complete`, and `skills.fetch_failed` payloads as human-readable skill fetch messages, including source repository, selected skills, and agent id when present.

The new-project form preloads `ssh://g1.sfl.io/sfl/agent-skills` on port `29419` with **Install all** enabled. This is a client-side form default, not the database/API default (`skill_sources_json` remains `[]` when a project is created outside that form); saving the untouched form persists the source.

The project form keeps remote skill-source validation on the normal save path. While that save is waiting on SSH checks, the primary action keeps showing `Saving…`; clicking it aborts the in-flight request and immediately starts a new save with the current SSH user/port/key/known-host field values. The modal also shows a persistent external skill-source check dashboard with each source URL, SSH user, SSH port, and per-source status (`checking`, `checked`, `failed`, `cancelled`, or `not checked`) so users can see what was attempted after a save error.

## Route surface

All `/api/admin/*` routes are declared in `buildApiRouter()` and its per-area route modules (see the **Files** table). This section summarizes them by **family**; for the exact method/path list read the owning route file, and for the authorization of each family see the **Route → permission map** in the Authentication section. Only the non-obvious per-route semantics are called out below.

### Public routes (no auth)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` / `/admin` | Dashboard HTML shell. |
| `GET` | `/health` | Health check. |
| `POST` | `/webhooks/:integrationId/:event` | Mounted only when webhook deps are provided. Per-integration HMAC secret is the auth layer. Redmine / GitLab only; Gerrit uses SSH `stream-events`. |
| `GET` | `/api/admin/auth/setup-status` | `{ needsSetup, credentialEncryptionConfigured }` — while setup is required, includes a non-sensitive boolean derived from whether `ADMIN_AUTH_SECRET` is present. The boolean is always `false` after setup and never exposes secret metadata. |
| `POST` | `/api/admin/auth/login` | `{ username, password }` → `{ token, user }` or 401. |
| `POST` | `/api/admin/auth/setup` | Bootstrap-only (403 once any user exists, including a concurrent setup winner). Rate-limited with `/login`. Atomically creates the first `admin`, logs in, 201, audits `auth.setup`. |

### Auth-protected route families

| Family | Owning file | Endpoints (representative) | Permission |
| --- | --- | --- | --- |
| Auth-self | `adminAuthRoutes.ts` | `POST /auth/logout`, `GET /auth/me` | `authenticated` |
| Users | `adminAuthRoutes.ts` | CRUD `/users`, `/users/:id`, `/users/:id/password` | `user.manage` (own password is `authenticated`) |
| Audit | `adminAuditRoutes.ts` | `GET /audit` (`limit`≤200, `offset`, `action`, `actor`) | `audit.read` |
| Overview / runtime | `adminOverviewRoutes.ts`, `adminServer.ts` | `/status`, `/config`, `/providers`, `/overview`, `/cost-summary`, `/model-usage` | `overview.read` |
| Streams | `adminStreamRoutes.ts` | SSE `/logs/stream?taskId=<id>` (required), `/events/stream` | `task.read` |
| Tasks | `adminTaskRoutes.ts` | list/detail/`cycles`/`transitions`, `pause`/`resume` (metadata rows), `retry`/`abandon` | `task.read` / `task.operate` / `task.delete` (scoped to owning project) |
| Prompts | `adminPromptRoutes.ts` | CRUD `/prompts` (`system` / `instructions` protected) | `prompt.read` / `prompt.write` / `prompt.delete` |
| Integrations | `adminIntegrationRoutes.ts` | CRUD, `/test`, `/:id/test`, `/:id/discover`, `/by-category` | `integration.read` / `integration.write` / `integration.delete` / `integration.operate` |
| Integration branches / models | `adminIntegrationRoutes.ts` | `GET /:id/branches?repoKey=…` (descriptor `discoverBranches`; 400/404/502; uncached), `GET /:id/models` | `integration.read` |
| Webhooks | `adminWebhookRoutes.ts` | `/:id/webhook-info`, `/:id/webhook-secret/rotate`, `/:id/webhook-allowed-ips` | `integration.operate` |
| SSH keys | `adminIntegrationRoutes.ts` | `/ssh-key/generate` (stateless), `/:id/ssh-key/{generate,public}`, `/ssh-agent/keys` | `integration.write` / `integration.read` |
| Plugins / OAuth | `adminIntegrationRoutes.ts` | `GET /plugins`, `/plugins/:type/oauth/{device-code,token,start,complete}`, `/oauth-apps` CRUD + `/resolve` | `integration.read` / `oauth.manage` |
| Agents | `adminAgentsRoutes.ts` | CRUD `/agents` (delete → 409 if referenced), `enable`/`disable` | `agent.read` / `agent.write` / `agent.delete` / `agent.operate` |
| Projects | `adminProjectsRoutes.ts` | CRUD `/projects`, `enable`/`disable`, `/skill-sources/list`, `/:id/skill-sources/list` | `project.read` / `project.write` / `project.delete` / `project.operate` (scoped, list-filtered) |
| Concurrency | `adminConcurrencyRoutes.ts` | `GET /concurrency` (live `{ global, perProject, perAgent }` snapshot; read-only) | `concurrency.read` |
| Settings | `adminSettingsRoutes.ts` | `GET`/`PUT /settings` (`pollingIntervalMs`, `maxAgentCycles`, `maxRetryAttempts`; hot-applied) | `system.read` / `system.write` |
| PBAC | `adminPoliciesRoutes.ts` | `/permissions`, `/groups` (+members), `/policies` (+`/rules`, `/bindings`) | `policy.manage` |

**Non-obvious per-route semantics** (not recoverable without reading source):

- **Users**: demoting/disabling/deleting the last enabled admin → 409; disabling or password-change revokes the target's sessions; non-admin password change requires a verified `currentPassword`.
- **Integrations**: `POST`/`PUT` encrypt descriptor password fields and internal credentials such as `webhookSecret`; credential writes return 400 with an actionable error when `ADMIN_AUTH_SECRET` is unset. `PUT` restores omitted/masked secrets from the stored row and clears the discovery cache on config change; GitHub repo discovery is token-centric (`/user/repos` filtered to the configured owner).
- **SSH key generate**: 400 when the provider lacks `generateSshKeyPair` or `ADMIN_AUTH_SECRET` is unset (keys must be stored encrypted); the stateless variant persists nothing.
- **`ssh-agent/keys`**: returns `{ keys: [], agentAvailable: false }` (never 5xx) when no agent socket / no identities.
- **Projects create/update**: `skillSources` SSH entries are validated with a bounded `ssh -T` before save (400 with source index/URL/stderr on failure). User-configured `sshKeyPath` and `sshKnownHostsPath` values must resolve under `/app/secrets` (container deployment) or the repository `secrets/` directory (host development); traversal is rejected. Coding payloads accept `gerritTopicOverride`, `useFullTicketUrlInCommits`, `postReviewLinkToTicket`, `reactToCiFailures` (off by default); `pushTargets` replace atomically; changing ticket source / push targets / review config / agent binding / post-clone script / skill toggle / skill sources — or enabling the project — auto-relaunches its `FAILED`/`REVIEW_FAILED` tasks (adopted orphan tasks included, unless created disabled).
- **Cost / model-usage**: optional `?days=<n>` trailing window; legacy cycles without a cost/model snapshot are recomputed from `agent_events`.
- **PBAC**: built-in policies return 409 on `PUT`/`DELETE`; `/rules` rejects unknown permissions (400); duplicate binding → 409, unknown principal → 404.

## Authentication

Two auth modes share the same route surface:

- **Bootstrap (zero users)**: while no users exist yet, every `/api/admin/*` route is open with an implicit `admin`-role context (`{ userId: null, username: "bootstrap" }`) set in `adminServer.ts`. There is no token or secret involved in this mode — `ADMIN_AUTH_SECRET` is unrelated to auth, but is mandatory before creating or loading stored provider credentials. `POST /api/admin/auth/setup` is the only route that matters here: production SQLite stores serialize the zero-user check and first-admin insert in one transaction, so concurrent requests yield exactly one 201 and the loser receives 403; password hashing still occurs before that transaction. A non-atomic compatibility fallback exists only for structural test doubles that predate `createInitialAdmin`. Stores without the user-store API (feature-detected via `countUsers`) stay in this open bootstrap mode permanently.
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

The admin server never returns plaintext password-like fields. Descriptor password fields and internal credentials such as integration `webhookSecret` values use the same versioned encrypted storage path. Credential-bearing integration creates and updates return 400 when `ADMIN_AUTH_SECRET` is unavailable. On `PUT`, values equal to `"********"`, empty strings, or omitted properties are merged from the stored row before validation so partial edits do not erase secrets.

## Dashboard behavior

[dashboard.ts](../../../src/admin/dashboard.ts) serves the shell for the Vite-built React SPA whose source lives in [src/admin/ui/](../../../src/admin/ui/); all client logic lives in the SPA, not inline in the shell.

**Login / setup flow (SPA)**: on load, the auth screen (`shell/AuthScreen.tsx`) calls the public `GET /api/admin/auth/setup-status`. When `needsSetup` is true it renders a “Create first admin” form (username + password ≥ 8, not a common password, + confirm) that POSTs directly to `/api/admin/auth/setup` — unauthenticated bootstrap, no secret or derived token is involved — which returns a session token. When `credentialEncryptionConfigured` is false, setup remains available but a warning explains that `ADMIN_AUTH_SECRET` encrypts provider credentials rather than the admin password, lists the unavailable credential-backed workflows, and gives `.env` generation plus local/Docker restart guidance (including why `docker restart` must not be used). Otherwise it renders a username/password login form backed by `POST /api/admin/auth/login`. The session token is kept in sessionStorage (`ve-admin-token`) and sent as a Bearer header on all API/SSE calls (plus the `?t=` query token for the log stream). `ui/api.ts` centralizes 401 handling: any 401 clears the token and fires an `onUnauthorized` callback that drops the app back to the login screen; 403 (insufficient role) never logs out — it surfaces as a normal error message.

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

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [plugins.md](plugins.md) — PluginManager hot-refresh wired from the admin server
- [configuration.md](../configuration.md) — admin env vars (`ADMIN_*`)
- [testing.md](../testing.md) — admin test families
