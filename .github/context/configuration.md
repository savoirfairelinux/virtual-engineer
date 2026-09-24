# Configuration Reference

**Source:** [src/config.ts](../../src/config.ts) — Zod-validated `AppConfig`. Empty strings are preprocessed to `undefined`, so env overrides like `FIELD=""` do not poison optional settings. A `.env` file in `process.cwd()` is loaded if present; existing `process.env` values win.

## Layered configuration

1. **Environment variables** populate `AppConfig` (system/infra settings only).
2. **All provider config** (Redmine, Gerrit, GitLab, GitHub, Copilot, Claude, Aider, Goose, Codex, Gemini, OpenCode, and Cursor credentials) lives exclusively in the `integrations` database table, managed via the admin UI.
3. `src/index.ts` hot-refreshes runtime dependencies after integration changes, so admin edits are picked up without a process restart.

## Environment variables

All variables are optional. Only system/infra settings remain in the environment layer.

### Application

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. `test` silences the logger by default. |
| `LOG_LEVEL` | `info` | Pino level. |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | SQLite file path. |
| `BACKUP_DIR` | `<DATABASE_PATH directory>/backups` | Local `.tar.gz` archive directory; defaults beside the database file. Admin UI controls scheduling/retention, not this path. Download or copy archives to separate storage for disaster recovery. |
| `VE_RESTORE_FROM` | — | One-shot archive path read at startup before SQLite opens. Archives do not contain `ADMIN_AUTH_SECRET`; restore requires the original secret and the deployment's OIDC/runtime configuration. Do not leave this set in a persistent environment after restore. |
| `VE_RESTORE_FORCE` | `false` | Explicitly permit replacement of existing database/prompt targets; existing targets are preserved in a `.pre-restore-*` directory. A completed restore writes a marker bound to the canonical archive path, full archive SHA-256, file size/mtime, and secret fingerprint. When the marker matches and both installed targets remain present, restarts return `already-restored` even if force is still true. If the marker matches but a target is missing, restore errors unless force is true, in which case it reapplies the archive. A different archive path/hash/metadata or secret does not match the marker; any existing targets then require force before replacement. Clear the one-shot restore variables after a successful restore. |

### Admin server

| Var | Default | Notes |
|---|---|---|
| `ADMIN_API_ENABLED` | `true` | Boolean. |
| `ADMIN_API_HOST` | `127.0.0.1` | Bind host. |
| `ADMIN_API_PORT` | `3100` | Port. |
| `ADMIN_AUTH_SECRET` | — | Required whenever provider credentials are created or already stored. Encrypts OAuth/password fields at rest with AES-256-GCM; startup fails closed if credentials exist without it. Backup creation and restore also require the same secret used to create the archive; v2 manifests use it to HMAC-authenticate the SQLite checksum and deterministically sorted prompt-override filename/hash inventory, but never store the secret. Earlier v1 archives are not accepted by the v2 restore path. `ConfigSchema` enforces a 32-character minimum when set (throws `Invalid configuration` with a message pointing to `openssl rand -hex 32`); the documented generation command produces a 64-character value. Admin auth itself uses DB-backed user accounts + session tokens (opaque Bearer token, sha256-hashed in `user_sessions`), **not** HMAC. |
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
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | Image the OpenShell sandbox is created from (`sandbox create --from`). |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | Host scratch directory for the per-task git workspace. The workspace is uploaded into the sandbox at `/sandbox` and (for coding runs) downloaded back; there are no Docker named volumes or bind mounts. |

There is **no** `AGENT_DOCKER_NETWORK` variable — sandbox egress is opened per run through OpenShell (`allowEgress`), not by attaching a Docker bridge network. `ConfigSchema` / `fromEnv()` cover exactly the 24 keys in the four tables above; nothing else in `src/config.ts` is env-backed.

### Read outside `ConfigSchema`

These are read directly from `process.env` and are **not** part of `AppConfig`:

| Var | Default | Read by | Notes |
|---|---|---|---|
| `SKILLS_CLI_PACKAGE` | `skills@1.5.16` | `src/admin/skillSourceDiscovery.ts`, `src/workspace/skillSources.ts`, `src/workspace/skillSourceInstaller.ts` | `npx` package used both to **list** installable skills for the project form and to **install** them host-side before workspace upload — see [modules/workspace.md](modules/workspace.md#external-skill-sources). |
| `OPENSHELL_GATEWAY` / `OPENSHELL_GATEWAY_ENDPOINT` | — | `src/runtime/runtimeStartup.ts` (`resolveOpenShellGateway`) | Gateway endpoint used for the startup health probe; `OPENSHELL_GATEWAY` wins. |
| `OPENSHELL_OIDC_CLIENT_SECRET` | — | `src/index.ts` | Presence enables the OpenShell client-credentials re-login path. |
| `SSH_AUTH_SOCK` | — | `src/admin/adminIntegrationRoutes.ts`, `src/admin/skillSourceDiscovery.ts` | Host-side SSH agent for admin-side discovery/validation only; never forwarded into a sandbox. |

### Docker launcher

`scripts/start.sh` reads `.env` without overriding existing environment variables.
These launcher settings are not part of `AppConfig`:

| Var | Default | Notes |
|---|---|---|
| `REVIEW_DIFF_TMPFS_SIZE` | `2g` | Size limit for the orchestrator's `/tmp/ve-review-diffs` tmpfs, shared by concurrent Gerrit diff fetches. Accepts a positive integer followed by `m` (MiB) or `g` (GiB); empty uses the default, zero and malformed values fail before startup side effects. |

This remains RAM-backed storage (potentially swapped), not a disk quota. Size it
for available memory and concurrent reviews; Git shallow fetches can still be
large. Review diff directories are cleaned after success or failure. Set, for
example, `REVIEW_DIFF_TMPFS_SIZE=4g` in `.env` and rerun `./scripts/start.sh` while
no tasks are active. The mount option participates in the existing run-config
hash, so changing it recreates the orchestrator container. This setting does not
change OpenShell sandbox limits or Kubernetes deployment storage.

### Restore launcher

`./scripts/start.sh --restore <archive> [--force] [--yes]` validates the local
archive, asks the operator to type `restore`, then stops/removes the existing
`ve-orchestrator` before starting its replacement with the archive mounted
read-only. `--yes` skips only the interactive confirmation and is intended for
explicit automation. `--force` is separate: use it only when replacing a
populated database or prompt directory is intended; the old targets are
quarantined under the data directory. The launcher-based restore works with
either OpenShell compute driver because the orchestrator remains a Docker
container. For the manifests-based Kubernetes deployment, follow the PVC
procedure in [deploy/k8s/README.md](../../deploy/k8s/README.md).

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
- [copilot-instructions.md](../copilot-instructions.md) — always-loaded routing and the rule that provider config lives in the database
