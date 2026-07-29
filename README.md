# Virtual Engineer

**Turn tickets and review events into isolated, traceable AI engineering workflows.**

Virtual Engineer is a self-hosted TypeScript orchestrator for two complementary jobs: implementing work from issue-tracker tickets and reviewing new code changes. It runs each agent cycle in a hardened, ephemeral Docker container, while the host retains source-control and review credentials.

Provider configuration, projects, agents, prompts, permissions, runtime settings, costs, and task history are managed from one authenticated Admin UI and persisted in SQLite.

## What It Does

| Workflow | Trigger | Virtual Engineer | Result |
| --- | --- | --- | --- |
| **Coding agent** | An assigned issue-tracker ticket | Clones the repository, runs an agent, creates commits, pushes them for review, and processes reviewer feedback | A reviewable Gerrit change, GitLab merge request, or GitHub pull request |
| **Review agent** | A new or updated patchset, merge request, or pull request | Fetches the diff, runs a focused review, filters and deduplicates findings, and responds to discussion threads | Inline comments, a summary, and a review vote or decision |

Coding tasks progress from detection through implementation and review to completion. Review tasks run independently and do not require a ticket source. See the [state-machine reference](.github/context/state-machine.md) for the complete lifecycle.

## Key Capabilities

- **Isolated execution**: every coding and review run uses an ephemeral Docker container with a read-only root filesystem, dropped Linux capabilities, and dedicated named volumes.
- **Host-owned credentials**: push and review credentials remain with the orchestrator; they are not placed in the agent workspace.
- **Multiple agent engines**: use GitHub Copilot, Claude Code, or Aider. Aider supports OpenAI, Anthropic, Ollama, OpenRouter, DeepSeek, and OpenAI-compatible endpoints.
- **Provider flexibility**: connect Redmine, GitLab, GitHub, or Gerrit, including multiple active instances of the same provider.
- **Feedback-aware delivery**: coding agents can iterate on reviewer feedback and selected CI failures while preserving the review history.
- **Automated review controls**: severity thresholds, comment limits, patchset-aware deduplication, and discussion-thread replies keep reviews useful and repeatable.
- **Operational visibility**: follow task transitions, live agent events, model usage, and AI cost from the Admin UI.
- **Policy-based access**: manage users, groups, policies, scoped project permissions, and an audit trail from the same interface.

## Supported Integrations

| Capability | Providers |
| --- | --- |
| Agent execution | GitHub Copilot, Claude Code, Aider |
| Issue tracking | Redmine, GitLab Issues, GitHub Issues |
| Source control and code review | Gerrit, GitLab Merge Requests, GitHub Pull Requests |
| Local development and workflow testing | Mock agent |

Provider integrations are configured in the Admin UI and stored encrypted in SQLite. Runtime dependencies are refreshed after integration changes without restarting the orchestrator. For authentication methods, model options, and engine-specific behavior, see the [agent reference](.github/context/modules/agents.md).

## Quick Start

The standard deployment runs the orchestrator in Docker and launches agent containers through the host Docker daemon.

### Requirements

- Docker 24 or newer
- OpenSSL for generating the credential-encryption secret
- Credentials for the external systems you choose to connect

### Start the Orchestrator

```bash
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
./scripts/start.sh
```

Open [http://127.0.0.1:3100/admin](http://127.0.0.1:3100/admin), create the first admin account, then configure integrations and projects. Follow the container logs with:

```bash
docker logs -f ve-orchestrator
```

Keep the generated `ADMIN_AUTH_SECRET` stable and stored securely. It encrypts provider credentials at rest; changing or losing it prevents existing credentials from being decrypted. It is separate from the Admin UI account password.

## Configure Your First Workflow

Use the Admin UI to assemble a workflow from reusable integrations, agents, and projects:

1. Add and test an **agent integration**: GitHub Copilot, Claude Code, or Aider.
2. Add the external integration required by the workflow: an **issue tracker** for coding, or a **review system** for code review.
3. Create a coding or review **agent**, select its model and prompts, and set its concurrency limit.
4. Create a matching **project** and bind its repository, target branch, integrations, and agent.
5. Enable the project. Assign a ticket for coding, or configure review-event delivery for review projects.

Gerrit review events use SSH `stream-events`. GitLab and GitHub review projects use authenticated webhooks. A review project does not need an issue-tracker integration.

The [Admin server reference](.github/context/modules/admin.md) describes the complete management surface, while the [configuration reference](.github/context/configuration.md) documents process-level settings.

## Local Development

Local development runs the orchestrator on the host while agent workloads still run in Docker.

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

## Architecture

The orchestrator runs on the host or in its own container. For each agent cycle it creates isolated Docker named volumes, clones the repository through a helper container, starts an ephemeral agent container, and then performs the push from the trusted host side. SQLite in WAL mode stores workflow state and allows interrupted tasks to resume after restart.

Read the [architecture guide](.github/context/architecture.md) for the full component and data-flow diagrams. The [documentation index](.github/context/INDEX.md) links to the database, plugins, connectors, VCS, state machine, testing, and module references.

## Security

Virtual Engineer handles source repositories, external credentials, and AI-generated changes. Review the trust boundaries before connecting production systems, keep the Admin UI on loopback or behind a trusted reverse proxy, and only run agents against repositories and external skill sources you trust.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

Virtual Engineer is licensed under the [GNU General Public License v3.0 only](LICENSE).
