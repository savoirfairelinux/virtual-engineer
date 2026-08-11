# 🤖 Virtual Engineer

**Turn tickets and review events into isolated, traceable AI engineering workflows.**

Virtual Engineer is a self-hosted TypeScript orchestrator for two complementary jobs: implementing work from issue-tracker tickets and reviewing new code changes. It runs each agent cycle in an isolated, ephemeral **OpenShell sandbox**, while the host retains source-control and review credentials.

Provider configuration, projects, agents, prompts, permissions, runtime settings, costs, and task history are managed from one authenticated Admin UI and persisted in SQLite.

## 🔄 What It Does

| Workflow | Trigger | Virtual Engineer | Result |
| --- | --- | --- | --- |
| **Coding agent** | An assigned issue-tracker ticket | Clones the repository, runs an agent, creates commits, pushes them for review, and processes reviewer feedback | A reviewable Gerrit change, GitLab merge request, or GitHub pull request |
| **Review agent** | A new or updated patchset, merge request, or pull request | Fetches the diff, runs a focused review, filters and deduplicates findings, and responds to discussion threads | Inline comments, a summary, and a review vote or decision |

Coding tasks progress from detection through implementation and review to completion. Review tasks run independently and do not require a ticket source. See the [state-machine reference](.github/context/state-machine.md) for the complete lifecycle.

## ✨ Key Capabilities

- **Isolated execution**: every coding and review run happens in an ephemeral OpenShell sandbox created per cycle and destroyed on exit. Isolation comes from the OpenShell gateway and deny-by-default runtime policies (network, filesystem, process, inference), not from ad-hoc container flags.
- **Host-owned credentials**: all Git plumbing (clone, checkout, cherry-pick, push) and review credentials remain with the orchestrator; they are never placed in the agent sandbox.
- **Multiple agent engines**: use GitHub Copilot, Claude Code, Aider, or Goose. Aider and Goose each wrap many LLM backends — see [Agent Engines & LLM Providers](#-agent-engines--llm-providers) below.
- **Provider flexibility**: connect Redmine, GitLab, GitHub, or Gerrit, including multiple active instances of the same provider.
- **Feedback-aware delivery**: coding agents can iterate on reviewer feedback and selected CI failures while preserving the review history.
- **Automated review controls**: severity thresholds, comment limits, patchset-aware deduplication, and discussion-thread replies keep reviews useful and repeatable.
- **Operational visibility**: follow task transitions, live agent events, model usage, AI cost, and sandbox policy denials from the Admin UI.
- **Policy-based access**: manage users, groups, policies, scoped project permissions, and an audit trail from the same interface.

## 🔌 Supported Integrations

| Capability | Providers |
| --- | --- |
| Agent execution | GitHub Copilot, Claude Code, Aider, Goose |
| Issue tracking | Redmine, GitLab Issues, GitHub Issues |
| Source control and code review | Gerrit, GitLab Merge Requests, GitHub Pull Requests |
| Local development and workflow testing | Mock agent |

Provider integrations are configured in the Admin UI and stored encrypted in SQLite. Runtime dependencies are refreshed after integration changes without restarting the orchestrator. For authentication methods, model options, and engine-specific behavior, see the [agent reference](.github/context/modules/agents.md).

## 🧠 Agent Engines & LLM Providers

Virtual Engineer supports five agent execution engines. The selected model lives on the `agents` table, not the integration config, so a single integration can serve many models.

| Engine | Auth / connection |
| --- | --- |
| **GitHub Copilot** | GitHub OAuth device flow, or a Personal Access Token |
| **Claude Code** | Anthropic API key, or Claude Pro/Max subscription via OAuth (auth-code + PKCE) |
| **Aider** | Per-backend API key (Ollama needs none) |
| **Goose** | Per-provider API key (Ollama/Bedrock need none) |
| **Mock** | None |

Each engine wraps one or more LLM backends:

- **GitHub Copilot** — GitHub Copilot models (CLI-managed; `auto` default)
- **Claude Code** — Anthropic Claude models
- **Aider** — OpenAI, Anthropic, Ollama (local), OpenRouter, DeepSeek, OpenAI-compatible (custom base URL)
- **Goose** — Anthropic, OpenAI, OpenRouter, Ollama (local), DeepSeek, Groq, Google Gemini, Azure OpenAI, Amazon Bedrock (AWS env), Perplexity, Mistral, xAI (Grok), Cerebras, OpenAI-compatible (custom base URL)
- **Mock** — Local testing only (success / no_change / failed)

Multiple active integrations of the same provider are supported in parallel. Credentials are stored encrypted in SQLite (Mock, Aider, and Goose store API keys plaintext at rest per their descriptors). For engine-specific behavior and native review strategies, see the [agent reference](.github/context/modules/agents.md).

## 🚀 Quick Start

`scripts/start.sh` is a one-shot setup: it builds the agent and orchestrator images, starts the pinned **OpenShell gateway** with its Docker compute driver, and starts the orchestrator wired to that gateway.

### Requirements

| Tool | Minimum | Notes |
|------|---------|-------|
| **Node.js** | 20 LTS | Orchestrator runtime (local development) |
| **Docker** | 24 | Runs the orchestrator, OpenShell gateway, and agent sandboxes |
| **OpenSSL** | — | Generates the credential-encryption secret |
| **k3s + kubectl** | current | Optional; only for the experimental Kubernetes compute driver. `start.sh` installs k3s and Helm automatically; `kubectl` must be on `PATH` |
| **GitHub Copilot** | — | Subscription required for code-gen/review tasks; GitHub account required |
| **Claude / Aider / Goose** | — | Alternative agent engines — API key or subscription per engine (optional) |

Plus credentials for the external systems you choose to connect.

### Start the Orchestrator

```bash
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
./scripts/start.sh
```

`start.sh` performs four steps:

1. builds the agent + orchestrator images (the orchestrator embeds the OpenShell CLI),
2. starts local Keycloak when external OIDC is not configured,
3. generates persistent sandbox-JWT keys and starts the pinned OpenShell gateway with its Docker compute driver,
4. starts the orchestrator (`ve-orchestrator`) wired to the gateway.

Agents then run as ephemeral OpenShell sandboxes (upload → exec → download). Git clone/checkout/push stay host-side in the orchestrator, so push credentials never enter the sandbox.

Open [http://127.0.0.1:3100/admin](http://127.0.0.1:3100/admin), create the first admin account, then configure integrations and projects. Follow the container logs with:

```bash
docker logs -f ve-orchestrator
```

> The orchestrator uses host networking, so external services on the same host are reachable via `http://localhost:<port>`.

### OIDC and compute driver

By default, `start.sh` deploys an authenticated local Keycloak realm and keeps its generated credentials under `data/local-oidc/` with owner-only permissions. To use an existing external Keycloak instead, set both values in `.env`:

```dotenv
OPENSHELL_OIDC_ISSUER=https://keycloak.example.com/realms/openshell
OPENSHELL_OIDC_CLIENT_SECRET=replace-with-the-confidential-client-secret
```

`start.sh` loads `.env` without evaluating it as shell code. Variables already exported by the calling shell take precedence over values in the file.

The Docker gateway API and health ports are published on host loopback only. The control port is also published on the private `openshell-docker` bridge so sandbox supervisors can authenticate with their gateway-minted JWT and call back without exposing the gateway on a public host interface.

#### Switching from Docker to Kubernetes (k3s)

`OPENSHELL_COMPUTE_DRIVER` selects how the OpenShell gateway schedules sandboxes: sibling Docker containers (`docker`, the default) or Pods on a k3s cluster (`kubernetes`, experimental). `start.sh` never changes this value on its own.

To switch:

1. Set `OPENSHELL_COMPUTE_DRIVER=kubernetes` in `.env`.
2. Re-run `./scripts/start.sh`. It installs `k3s` and `helm` if not already present, deploys the OpenShell gateway via Helm into the `virtual-engineer` namespace, and schedules sandbox Pods instead of Docker containers. `kubectl` must be on `PATH`.

To switch back, set `OPENSHELL_COMPUTE_DRIVER=docker` (or delete the line) and re-run `./scripts/start.sh`. Both drivers use the same `OpenShellWorkspaceRunner`; only the gateway's compute backend changes.

Both drivers share `data/local-oidc/client-secret` for the managed local Keycloak. The first time you switch to a driver, `start.sh` deploys that driver's own Keycloak instance using this secret, so no manual sync is needed. If a driver's Keycloak was already deployed with a *different* secret (for example, a `data/` directory reused from another machine or an older session), `start.sh` fails with an explicit error naming the exact command to delete that driver's stale Keycloak deployment so it can re-import the realm.

Keep the generated `ADMIN_AUTH_SECRET` stable and stored securely. It encrypts provider credentials at rest; changing or losing it prevents existing credentials from being decrypted. It is separate from the Admin UI account password.

## 🧭 Configure Your First Workflow

Use the Admin UI to assemble a workflow from reusable integrations, agents, and projects:

1. Add and test an **agent integration**: GitHub Copilot, Claude Code, Aider, or Goose.
2. Add the external integration required by the workflow: an **issue tracker** for coding, or a **review system** for code review.
3. Create a coding or review **agent**, select its model and prompts, and set its concurrency limit.
4. Create a matching **project** and bind its repository, target branch, integrations, and agent.
5. Enable the project. Assign a ticket for coding, or configure review-event delivery for review projects.

Gerrit review events use SSH `stream-events`. GitLab and GitHub review projects use authenticated webhooks. A review project does not need an issue-tracker integration.

The [Admin server reference](.github/context/modules/admin.md) describes the complete management surface, while the [configuration reference](.github/context/configuration.md) documents process-level settings.

## 🛠️ Local Development

Local development runs the orchestrator on the host while agent workloads still run in OpenShell sandboxes.

### Development Requirements

- Node.js 22 or newer
- Docker 24 or newer
- npm 10 or newer

```bash
npm install
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm run db:migrate
npm run build:ui
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev
```

The Admin UI is available at [http://127.0.0.1:3100/admin](http://127.0.0.1:3100/admin). Rebuild the agent image after changing `Dockerfile.agent`, `agent-worker/`, or a host-side agent adapter.

Useful development commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Vitest test suite |
| `npm run typecheck` | Type-check the orchestrator and agent worker |
| `npm run typecheck:ui` | Type-check the Admin UI |
| `npm run lint` | Run ESLint across source and tests |
| `npm run build` | Build the Admin UI and TypeScript application |
| `npm run reset:instance` | Reset local tasks, integrations, agents, and projects |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions, quality gates, and contribution guidance.

## 🏗️ Architecture

The orchestrator runs on the host or in its own container. For each agent cycle it creates an ephemeral host working directory, clones the repository host-side, uploads that workspace into a uniquely named OpenShell sandbox, executes the agent there, downloads the result, and then performs the push from the trusted host side. Sandbox isolation comes from the OpenShell gateway and deny-by-default runtime policies. SQLite in WAL mode stores workflow state and allows interrupted tasks to resume after restart.

Read the [architecture guide](.github/context/architecture.md) for the full component and data-flow diagrams. The [documentation index](.github/context/INDEX.md) links to the database, plugins, connectors, VCS, state machine, testing, and module references.

## ⚙️ Process Configuration

Provider credentials and workflow settings live in SQLite and are managed from the Admin UI. Only process-level settings come from the environment:

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `test` silences the logger |
| `LOG_LEVEL` | `info` | pino levels; `.env.example` sets `debug` for development |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | |
| `ADMIN_API_HOST` | `127.0.0.1` | Loopback by default; set `0.0.0.0` to expose on the network (Docker mode) |
| `ADMIN_API_PORT` | `3100` | |
| `ADMIN_AUTH_SECRET` | — | Encrypts provider credentials at rest (AES-256-GCM); admin auth uses DB-backed accounts + session tokens |
| `ADMIN_TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` value; only enable behind a trusted reverse proxy |
| `POLLING_INTERVAL_MS` | `30000` | **DB-managed** — seed only; edit at runtime via Admin UI → System Settings |
| `MAX_AGENT_CYCLES` | `3` | **DB-managed** — seed only; edit at runtime via Admin UI → System Settings |
| `MAX_RETRY_ATTEMPTS` | `5` | **DB-managed** — seed only; edit at runtime via Admin UI → System Settings |
| `AGENT_TIMEOUT_MS` | `3600000` | **DB-managed** — host-side agent timeout (ms, 60 min); also bounds the OpenShell remote exec |
| `MAX_COMMITS_PER_CYCLE` | `10` | Max atomic commits per agent cycle |
| `MAX_REVIEW_DIFF_CHARS` | `60000` | Max diff characters injected into a review prompt |
| `MAX_REVIEW_COMMENTS` | `20` | Max inline comments posted per review pass (excess folded into summary) |
| `MAX_REVIEW_REPLIES` | `20` | Max discussion-thread replies posted per review pass |
| `REVIEW_MIN_SEVERITY` | `info` | Min severity to post inline (`nit` < `info` < `warning` < `error`) |
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | Base image for the OpenShell agent sandbox |
| `WORKSPACE_BASE_DIR` | `/tmp/virtual-engineer/workspaces` | Host-side scratch space for cloned workspaces + review diffs |
| `SKILLS_CLI_PACKAGE` | `skills@1.5.16` | `npx` package used to list configured remote skill sources |
| `OPENSHELL_COMPUTE_DRIVER` | `docker` | Gateway compute backend; `kubernetes` is experimental and requires k3s |
| `OPENSHELL_OIDC_ISSUER` | managed local Keycloak | External Keycloak realm issuer URL; set together with the client secret |
| `OPENSHELL_OIDC_CLIENT_ID` | `openshell-ci` | Keycloak confidential-client id used by the OpenShell CLI |
| `OPENSHELL_OIDC_CLIENT_SECRET` | generated locally | External confidential-client secret; set together with the issuer |
| `OPENSHELL_OIDC_AUDIENCE` | `openshell-cli` | Expected OpenShell OIDC audience |

See the [configuration reference](.github/context/configuration.md) for the complete list.

## 🔒 Security

Virtual Engineer handles source repositories, external credentials, and AI-generated changes. Review the trust boundaries before connecting production systems, keep the Admin UI on loopback or behind a trusted reverse proxy, and only run agents against repositories and external skill sources you trust.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## 📄 License

Virtual Engineer is licensed under the [GNU General Public License v3.0 only](LICENSE).
