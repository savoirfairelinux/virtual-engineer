# Configuration Reference

**Source:** [src/config.ts](../../src/config.ts) — Zod-validated `AppConfig`. Empty strings are preprocessed to `undefined`, so env overrides like `FIELD=""` do not poison optional settings. A `.env` file in `process.cwd()` is loaded if present; existing `process.env` values win.

## Layered configuration

1. **Environment variables** populate `AppConfig` (system/infra settings only).
2. **All provider config** (Redmine, Gerrit, GitLab, Copilot, and Claude credentials) lives exclusively in the `integrations` database table, managed via the admin UI.
3. `src/index.ts` hot-refreshes runtime dependencies after integration changes, so admin edits are picked up without a process restart.

## Environment variables

All variables are optional. Only system/infra settings remain in the environment layer.

### Application

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. `test` silences the logger by default. |
| `LOG_LEVEL` | `info` | Pino level. |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | SQLite file path. |

### Admin server

| Var | Default | Notes |
|---|---|---|
| `ADMIN_API_ENABLED` | `true` | Boolean. |
| `ADMIN_API_HOST` | `127.0.0.1` | Bind host. |
| `ADMIN_API_PORT` | `3100` | Port. |
| `ADMIN_AUTH_SECRET` | — | Required whenever provider credentials are created or already stored. Encrypts OAuth/password fields at rest with AES-256-GCM; startup fails closed if credentials exist without it. `ConfigSchema` enforces a 32-character minimum when set (throws `Invalid configuration` with a message pointing to `openssl rand -hex 32`); the documented generation command produces a 64-character value. Admin auth itself uses DB-backed user accounts + session tokens (opaque Bearer token, sha256-hashed in `user_sessions`), **not** HMAC. |
| `ADMIN_TRUST_PROXY` | `false` | When `true`, derive the client IP from the first `X-Forwarded-For` value for login rate-limiting and webhook IP restrictions. Enable only behind a trusted reverse proxy that overwrites inbound forwarding headers. Webhook signatures remain mandatory. |

There is no `PUBLIC_BASE_URL` env var in `ConfigSchema`; a `publicBaseUrl` value exists only as an optional dependency field wired into the admin server (used to render webhook URLs), not as configuration parsed by `src/config.ts`.

### Workflow

| Var | Default | Notes |
|---|---|---|
| `POLLING_INTERVAL_MS` | `30000` | **DB-managed** seed only. Tick interval for the polling loop (ms); the live value lives in `app_settings` and is edited at runtime via admin UI → System Settings. |
| `MAX_AGENT_CYCLES` | `3` | **DB-managed** seed only. Per-task cap for ticket-driven codegen tasks. |
| `MAX_RETRY_ATTEMPTS` | `5` | **DB-managed** seed only. Per-ticket cap; polling skips tickets once exceeded. |
| `MAX_COMMITS_PER_CYCLE` | `10` | Upper bound on commits the agent may create in one cycle. |
| `AGENT_TIMEOUT_MS` | `3_600_000` | **DB-managed** seed only. Host-side agent timeout (60 min); the live value lives in `app_settings` and is edited at runtime via admin UI → System Settings. |
| `TICKET_CLOSE_MAX_RETRIES` | `5` | **DB-managed** seed only. `pRetry` retry count for `closeTicket()`'s ticket-closing call after MERGED; the live value lives in `app_settings` and is edited at runtime via admin UI → System Settings. |
| `TICKET_CLOSE_RETRY_MIN_TIMEOUT_MS` | `5000` | **DB-managed** seed only. `pRetry` minimum backoff (ms) between ticket-close retries; the live value lives in `app_settings` and is edited at runtime via admin UI → System Settings. |
| `MAX_REVIEW_DIFF_CHARS` | `60_000` | Max diff characters injected into the review prompt. |
| `MAX_REVIEW_COMMENTS` | `20` | Max inline comments posted per review pass; the rest are folded into the summary. |
| `MAX_REVIEW_REPLIES` | `20` | Max discussion-thread replies VE posts per review pass. |
| `REVIEW_MIN_SEVERITY` | `info` | Minimum severity (`nit` < `info` < `warning` < `error`) for an inline comment; lower severities are folded into the summary. |

### Agent runtime / workspace

| Var | Default | Notes |
|---|---|---|
| `WORKSPACE_RUNTIME` | `legacy` | `legacy` uses the Docker named-volume runner; `openshell` opts into the OpenShell sandbox runner and requires a reachable gateway. |
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | Agent image used by either runtime. |
| `AGENT_DOCKER_NETWORK` | `virtual-engineer_ve-agent-net` | Docker network attached to legacy agent containers. |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | Host scratch directory used by the legacy runner and by OpenShell's host-side Git workspace. |

The default `legacy` runtime creates `ve-ws-*` and `ve-home-*` named volumes, runs agent/review containers with the configured Docker network, and performs Git operations in helper containers. The `openshell` runtime opens egress through `allowEgress` and requires `OPENSHELL_GATEWAY` or `OPENSHELL_GATEWAY_ENDPOINT`. `ConfigSchema` / `fromEnv()` cover the keys in the four tables above; nothing else in `src/config.ts` is env-backed.

### Read outside `ConfigSchema`

These are read directly from `process.env` and are **not** part of `AppConfig`:

| Var | Default | Read by | Notes |
|---|---|---|---|
| `SKILLS_CLI_PACKAGE` | `skills@1.5.16` | `src/admin/skillSourceDiscovery.ts`, `src/workspace/skillSources.ts`, `src/workspace/skillSourceInstaller.ts` | `npx` package used both to **list** installable skills for the project form and to **install** them host-side before workspace upload — see [modules/workspace.md](modules/workspace.md#external-skill-sources). |
| `OPENSHELL_GATEWAY` / `OPENSHELL_GATEWAY_ENDPOINT` | — | `src/runtime/runtimeStartup.ts` (`resolveOpenShellGateway`) | Gateway endpoint used for the startup health probe; `OPENSHELL_GATEWAY` wins. |
| `OPENSHELL_OIDC_CLIENT_SECRET` | — | `src/index.ts` | Presence enables the OpenShell client-credentials re-login path. |
| `SSH_AUTH_SOCK` | — | `src/admin/adminIntegrationRoutes.ts`, `src/admin/skillSourceDiscovery.ts` | Host-side SSH agent for admin-side discovery/validation only; never forwarded into a sandbox. |

## Boot-time validation

`getConfig()` parses `process.env` once and throws on invalid combinations, listing all offending fields. Tests call `resetConfig()` to invalidate the singleton cache between cases.

Validation rules:
- `NODE_ENV` must be `development`, `production`, or `test`.
- `ADMIN_API_PORT` must be a positive integer.
- All numeric fields must be positive integers.

## Testing patterns

- Unit tests use `vi.stubEnv("KEY", "VALUE")` or temporary `process.env` mutation plus `resetConfig()`.
- Integration tests seed DB-backed integrations and agents via the admin API.
- Unit tests use Vitest mocks and local fakes, so the test suite does not require external provider systems.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [architecture.md](architecture.md) — layered architecture and data flow
- [database.md](database.md) — `app_settings` (DB-managed workflow settings, including the agent timeout)
- [testing.md](testing.md) — env-var stubbing patterns (`resetConfig`)
- [copilot-instructions.md](../copilot-instructions.md) — Key Configuration table (always-loaded)
