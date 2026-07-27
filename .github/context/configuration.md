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
| `ADMIN_AUTH_SECRET` | — | Required whenever provider credentials are created or already stored. Encrypts OAuth/password fields at rest with AES-256-GCM; startup fails closed if credentials exist without it. Admin auth itself uses DB-backed user accounts + session tokens (opaque Bearer token, sha256-hashed in `user_sessions`), **not** HMAC. |
| `ADMIN_TRUST_PROXY` | `false` | When `true`, derive the client IP from the first `X-Forwarded-For` value for login rate-limiting and webhook IP restrictions. Enable only behind a trusted reverse proxy that overwrites inbound forwarding headers. Webhook signatures remain mandatory. |

There is no `PUBLIC_BASE_URL` env var in `ConfigSchema`; a `publicBaseUrl` value exists only as an optional dependency field wired into the admin server (used to render webhook URLs), not as configuration parsed by `src/config.ts`.

### Workflow

| Var | Default | Notes |
|---|---|---|
| `POLLING_INTERVAL_MS` | `30000` | **DB-managed** seed only. Tick interval for the polling loop (ms); the live value lives in `app_settings` and is edited at runtime via admin UI → System Settings. |
| `MAX_AGENT_CYCLES` | `3` | **DB-managed** seed only. Per-task cap for ticket-driven codegen tasks. |
| `MAX_RETRY_ATTEMPTS` | `5` | **DB-managed** seed only. Per-ticket cap; polling skips tickets once exceeded. |
| `MAX_COMMITS_PER_CYCLE` | `10` | Upper bound on commits the agent may create in one cycle. |
| `AGENT_TIMEOUT_MS` | `3_600_000` | Host-side agent timeout (60 min). |
| `MAX_REVIEW_DIFF_CHARS` | `60_000` | Max diff characters injected into the review prompt. |
| `MAX_REVIEW_COMMENTS` | `20` | Max inline comments posted per review pass; the rest are folded into the summary. |
| `MAX_REVIEW_REPLIES` | `20` | Max discussion-thread replies VE posts per review pass. |
| `REVIEW_MIN_SEVERITY` | `info` | Minimum severity (`nit` < `info` < `warning` < `error`) for an inline comment; lower severities are folded into the summary. |

### Docker / workspace

| Var | Default | Notes |
|---|---|---|
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | |
| `AGENT_DOCKER_NETWORK` | `virtual-engineer_ve-agent-net` | Bridge network attached to agent containers. |
| `SKILLS_CLI_PACKAGE` | `skills@1.5.16` | `npx` package used to list/install configured remote skill sources. Read directly via `process.env` in `skillSourceDiscovery.ts` / `workspace/skillSources.ts` — **not** part of `ConfigSchema`/`AppConfig`. |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | Scratch space for host-side review diffs; agent workspaces use Docker **named volumes** (`/workspace` + `/ve-home`), not host bind mounts. |

## Boot-time validation

`getConfig()` parses `process.env` once and throws on invalid combinations, listing all offending fields. Tests call `resetConfig()` to invalidate the singleton cache between cases.

Validation rules:
- `NODE_ENV` must be `development`, `production`, or `test`.
- `ADMIN_API_PORT` must be a positive integer.
- All numeric fields must be positive integers.

## Testing patterns

- Unit tests use `vi.stubEnv("KEY", "VALUE")` or temporary `process.env` mutation plus `resetConfig()`.
- Integration tests seed DB-backed integrations and agents via the admin API.
- Mock-mode runs (`npm run e2e:mock`) avoid external systems entirely.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [architecture.md](architecture.md) — layered architecture and data flow
- [database.md](database.md) — `app_settings` (DB-managed workflow settings)
- [testing.md](testing.md) — env-var stubbing patterns (`resetConfig`)
- [copilot-instructions.md](../copilot-instructions.md) — Key Configuration table (always-loaded)
