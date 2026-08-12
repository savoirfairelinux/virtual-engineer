# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report them privately so we can assess and address the issue before any public disclosure:

- **Email**: contact@savoirfairelinux.com

We aim to:

1. Acknowledge your report within **48 hours**
2. Provide a confirmed assessment within **7 days**
3. Issue a fix and coordinated disclosure within **90 days** (or sooner for critical issues)

Please include as much detail as possible: steps to reproduce, impact assessment, and any suggested fix.

## Security Architecture

### Agent Container Isolation

Each agent cycle runs in an ephemeral OpenShell sandbox constrained by a deny-by-default runtime policy:

- `--read-only` root filesystem
- `--cap-drop ALL` — no Linux capabilities granted
- `--security-opt no-new-privileges:true`
- Only `/sandbox`, `/tmp` and `/dev/null` are writable; `/usr`, `/lib`, `/app`, `/etc` are read-only
- Isolated to the `ve-agent-net` bridge network — no host network access

The host owns all push/review credentials and orchestrates network operations; the agent container never holds provider secrets.

### Project Skill Discovery

Every coding and review run uses the selected agent's native repository behavior. VE does not define a local skill path, scan manifests, or provide a disable switch. Remote skill sources are separate optional project configuration (`projects.skill_sources_json`); `OpenShellWorkspaceRunner` fetches and installs them **on the host**, before the workspace is uploaded to the sandbox, so SSH material and `SKILL_SOURCES_JSON` never reach the sandbox — only the resulting skill files do. Skills are instructions executed by the agent, so a malicious repository or remote skill source could steer the agent. Mitigations:

- Run Virtual Engineer only against repositories whose agent configuration, skills, MCP files, and change-review trust boundary you accept.
- Remote skill sources default to an empty list and must be configured explicitly; add only sources you trust.
- Host installation targets only the selected agent's native project directory: Copilot, Claude, Goose, Codex, and OpenCode are supported; Aider and Mock are skipped.
- Review runs are never downloaded back to the host, so a review agent cannot modify the repository VE pushes.
- SSH remote skill sources reuse the orchestrator process `SSH_AUTH_SOCK` only when such a source is configured; missing SSH agent access fails the run instead of silently skipping skills. Configured key and known-hosts files must live under `/app/secrets` (container deployment) or the repository `secrets/` directory (host development). Canonical-path validation blocks traversal and symlink escapes before host-file reads.
- Copilot enables native config discovery, which couples repository skill discovery with repository MCP configuration discovery. VE permission handlers still mediate requested tools, but repository MCP servers may be initialized; trust the repository before running it.
- Claude enables native user/project settings and skills while retaining `strictMcpConfig=true`, so Claude ignores repository MCP server configuration and accepts only VE-provided MCP servers.
- The internal VE stdio MCP server exposes only `ve_submit_review` or `ve_submit_changes`, validates one bounded JSON payload, and writes it to the ephemeral agent-home volume with mode `0600`. It has no network tools, database access, Docker socket, push/review credentials, or task-state operations.
- The agent still runs inside the hardened, network-isolated container described above and never holds provider push/review credentials.

### Admin API Authentication

The admin dashboard is protected by account-based authentication (username/password, DB-backed sessions). Admin users are managed via the Users tab (admin role required). Session tokens are opaque random values stored as SHA-256 hashes in the database. Bind the admin port to `127.0.0.1` in production.

`ADMIN_AUTH_SECRET` is required before provider credentials can be created or loaded from the database. Credentials are encrypted with AES-256-GCM in a versioned `veenc:v1:` envelope. Startup fails closed if the secret is absent, if marked ciphertext cannot be authenticated, or if probable legacy unprefixed AES ciphertext cannot be decrypted with the configured secret. Legacy `plain:` and valid unprefixed AES values are rewritten into the versioned format during startup migration. `ADMIN_AUTH_SECRET` is not used for admin authentication.

### Secrets Storage

Provider credentials are stored encrypted in SQLite and masked on all admin API reads. New plaintext credential writes are rejected. Webhook secrets support per-integration rotation and are never returned in plaintext after initial creation.

### Content Security Policy

All dashboard `<script>` tags use a per-request nonce. Bootstrap JSON embedded in the HTML is sanitised with Unicode escapes (`\u003c`, `\u003e`, `\u0026`) to prevent script injection through the JSON context.

### Dependency Security

Run `npm audit` regularly to detect vulnerable dependencies. We recommend pinning dependency versions in production deployments.
