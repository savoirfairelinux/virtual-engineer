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

### Repository Skill Discovery

Skill discovery is a **per-project, coding-only** setting (`projects.skill_discovery_enabled`, default **off**) chosen in the project-setup form — not an environment flag. When enabled, the in-container agent loads team-defined skills from `<repo>/.github/skills` in the cloned repository. Skills are repository-controlled instructions executed by the agent, so they are a **prompt-injection surface**: a malicious or compromised repo could steer the agent. Mitigations:

- The setting is **disabled by default**; enable it only for repositories you trust.
- It applies to code-generation projects only — host-side review never loads skills.
- Only skills are loaded — MCP discovery (`enableConfigDiscovery`) stays off, so untrusted `.mcp.json` / `.vscode/mcp.json` files are never honoured.
- The agent still runs inside the hardened, network-isolated container described above and never holds provider push/review credentials.

### Admin API Authentication

The admin dashboard is protected by an HMAC-SHA256 bearer token derived from `ADMIN_AUTH_SECRET`. Tokens embed a timestamp and are validated server-side to prevent replay attacks. Bind the admin port to `127.0.0.1` in production.

### Secrets Storage

Provider credentials are stored encrypted in SQLite and masked on all admin API reads. Webhook secrets support per-integration rotation and are never returned in plaintext after initial creation.

### Content Security Policy

All dashboard `<script>` tags use a per-request nonce. Bootstrap JSON embedded in the HTML is sanitised with Unicode escapes (`\u003c`, `\u003e`, `\u0026`) to prevent script injection through the JSON context.

### Dependency Security

Run `npm audit` regularly to detect vulnerable dependencies. We recommend pinning dependency versions in production deployments.
