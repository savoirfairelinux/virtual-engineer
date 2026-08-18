# 🤖 Virtual Engineer

**Turn tickets and review events into isolated, traceable AI engineering workflows.**

Virtual Engineer is a self-hosted orchestrator that runs AI agents against real
repositories while keeping Git and code-review credentials on the host.

## 🔄 What It Does

| Workflow | Input | Result |
| --- | --- | --- |
| **Coding** | An assigned issue-tracker ticket | Agent commits pushed for review, with feedback cycles |
| **Review** | A new patchset, merge request, or pull request | Inline findings, discussion replies, and a review decision |

Every cycle runs in an ephemeral OpenShell sandbox. The host performs the Git
clone and push operations; the sandbox is destroyed after the cycle.

## 🔌 Supported Systems

| Capability | Providers |
| --- | --- |
| Agent execution | GitHub Copilot, Claude Code, Aider, Goose, Codex, Gemini CLI, OpenCode, Cursor |
| Issue tracking | Redmine, GitLab Issues, GitHub Issues |
| Source control and code review | Gerrit, GitLab Merge Requests, GitHub Pull Requests |

Provider configuration, projects, agents, prompts, permissions, runtime
settings, costs, and task history are managed from the authenticated Admin UI
and stored in SQLite. Provider credentials and other secret fields are
encrypted at rest.

## 🚀 Quick Start

The installer builds the agent and orchestrator images, starts local Keycloak
when needed, starts the pinned OpenShell gateway, and launches the orchestrator.

Requirements: Git, curl, OpenSSL, Docker 24+, and a running Docker daemon.

```bash
curl -fsSL https://raw.githubusercontent.com/savoirfairelinux/virtual-engineer/main/scripts/install.sh | bash
```

The installer clones the repository into `./virtual-engineer` (or reuses the
current directory when it already is a checkout), creates `.env`, and generates
`ADMIN_AUTH_SECRET`. It supports `VE_REF` and `VE_EXPECTED_COMMIT`; see the
[installer script](scripts/install.sh) for reviewable and pinned-install flows.

Open the Admin UI at [http://127.0.0.1:3100/admin](http://127.0.0.1:3100/admin),
create the first admin account, and configure the integrations and projects.

For a checkout that already exists:

```bash
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
./scripts/start.sh
```

The default deployment uses Docker for OpenShell sandboxes. Kubernetes is an
experimental alternative; see the [Kubernetes deployment guide](deploy/k8s/README.md).

## 🧭 First Workflow

1. Add and test an agent integration.
2. Add an issue-tracker integration for coding, or a review integration for review tasks.
3. Create an agent and select its model and prompts.
4. Create a project, bind its repository, branch, integrations, and agent, then enable it.

Coding projects pick up assigned tickets. Review projects receive Gerrit
stream events or GitLab/GitHub webhook events and do not require an issue tracker.

## 🛠️ Local Development

Requirements: Node.js 22+, npm 10+, Docker 24+, OpenShell CLI 0.0.83, and a
reachable OpenShell gateway.

```bash
npm install
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm run db:migrate
npm run build:ui
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev
```

`npm run dev` starts the host orchestrator only. Configure
`OPENSHELL_GATEWAY` with an existing CLI profile or
`OPENSHELL_GATEWAY_ENDPOINT` with a reachable endpoint before running it.
Use `./scripts/start.sh` for the complete containerized path.

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, type-checking, linting, and
database workflow.

## 📚 Documentation

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Kubernetes deployment](deploy/k8s/README.md)
- [Security architecture and reporting](SECURITY.md)
- [Detailed agent reference](.github/context/modules/agents.md)
- [Configuration reference](.github/context/configuration.md)

## 📄 License

Virtual Engineer is licensed under the [GNU General Public License v3.0 only](LICENSE).
