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

Each agent cycle runs in an ephemeral Docker container hardened with:

- `--read-only` root filesystem
- `--cap-drop ALL` — no Linux capabilities granted
- `--security-opt no-new-privileges:true`
- Only `/tmp` (tmpfs, 256 MB, `nosuid`) and named volumes are writable
- Isolated to the `ve-agent-net` bridge network — no host network access

The host owns all push/review credentials and orchestrates network operations; the agent container never holds provider secrets.

### Project Skill Discovery

Skill discovery is a **per-project** setting (`projects.skill_discovery_enabled`, default **off**) available to both coding and review projects — chosen in the project-setup form, not an environment flag. When enabled, the in-container agent loads team-defined local skills from `projects.local_skills_path` (default `.github/skills`) in the cloned repository. Remote skill sources are separate explicit project configuration (`projects.skill_sources_json`) and are fetched with `npx skills` into `/ve-home` whenever configured. Skills are project-approved instructions executed by the agent, so they are a **prompt-injection surface**: a malicious repository or remote skill source could steer the agent. Mitigations:

- Local skill discovery is **disabled by default**; enable it only for repositories you trust.
- Remote skill sources default to an empty list and must be configured explicitly; add only sources you trust.
- Remote skills install globally in the agent home volume (`/ve-home`), not into the cloned repository. This keeps review workspaces read-only.
- SSH remote skill sources reuse the orchestrator process `SSH_AUTH_SOCK` only when such a source is configured; missing SSH agent access fails the run instead of silently skipping skills. Configured key and known-hosts files must live under `/app/secrets` (container deployment) or the repository `secrets/` directory (host development). Canonical-path validation blocks traversal and symlink escapes before host-file reads.
- Only skills are loaded — MCP discovery (`enableConfigDiscovery`) stays off, so untrusted `.mcp.json` / `.vscode/mcp.json` files are never honoured.
- The agent still runs inside the hardened, network-isolated container described above and never holds provider push/review credentials.

### Admin API Authentication

The admin dashboard is protected by account-based authentication (username/password, DB-backed sessions). Admin users are managed via the Users tab (admin role required). Session tokens are opaque random values stored as SHA-256 hashes in the database. Bind the admin port to `127.0.0.1` in production.

`ADMIN_AUTH_SECRET` is an optional encryption key used to encrypt OAuth session tokens stored in the database. It is not used for admin authentication.

### Secrets Storage

Provider credentials are stored encrypted in SQLite and masked on all admin API reads. Webhook secrets support per-integration rotation and are never returned in plaintext after initial creation.

### Content Security Policy

All dashboard `<script>` tags use a per-request nonce. Bootstrap JSON embedded in the HTML is sanitised with Unicode escapes (`\u003c`, `\u003e`, `\u0026`) to prevent script injection through the JSON context.

### Dependency Security

Run `npm audit` regularly to detect vulnerable dependencies. We recommend pinning dependency versions in production deployments.
