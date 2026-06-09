# Virtual Engineer

AI-driven development system with two independent flows.

**Coding agent** — Assign a ticket to the `virtual-engineer` account. The orchestrator clones the repo, runs the Copilot agent in an isolated Docker container, pushes the resulting commits for review, iterates on reviewer feedback, and closes the ticket once the change is merged.

**Code review agent** — On every new or updated patchset (Gerrit stream-event or GitLab webhook), the orchestrator fetches the diff, runs Copilot on the host, and posts inline comments + a vote directly on the review system. No ticket required.

All provider configuration (ticketing, VCS, agent) is stored in SQLite and managed through the admin UI — no env-var plumbing required.

<p align="center">
	<img src="https://cdn.simpleicons.org/github/181717" alt="GitHub" width="20" />
	<img src="https://cdn.simpleicons.org/githubcopilot/000000" alt="GitHub Copilot" width="20" />
	<img src="https://cdn.simpleicons.org/gitlab/FC6D26" alt="GitLab" width="20" />
	<img src="https://cdn.simpleicons.org/gerrit/EE0000" alt="Gerrit" width="20" />
	<img src="https://cdn.simpleicons.org/redmine/B32024" alt="Redmine" width="20" />
</p>

---

## Prerequisites

| Tool | Minimum | Notes |
|------|---------|-------|
| **Node.js** | 20 LTS | Orchestrator runtime |
| **Docker** | 24 | Agent container execution |
| **GitHub Copilot** | — | Subscription required for code-gen/review tasks |

---

## Prod setup (orchestrator in Docker)

```bash
cp .env.example .env                                                 # fill in HMAC-KEY
./scripts/init-infra.sh                                              # prepare data/, secrets/, and the agent Docker network, 
./scripts/start-orchestrator.sh
```

> **Important:** always run `init-infra.sh` before the first `start-orchestrator.sh`. If Docker starts first it creates `data/` and `secrets/` as root, making them inaccessible. Fix retroactively with `sudo chown $USER:$USER data/ secrets/`.

Admin UI: http://127.0.0.1:3100/admin  
Logs: `docker logs -f ve-orchestrator`

> In Docker mode the orchestrator uses host networking, so external services on the same host are reachable via `http://localhost:<port>`.

---

## Dev setup (orchestrator on host)

```bash
npm install
cp .env.example .env
npm run db:migrate
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev
```

Admin UI: http://127.0.0.1:3100/admin

---

## Configure a project (Admin UI)

Open **http://127.0.0.1:3100/admin** and follow the steps for your flow.

### Coding agent flow

The orchestrator picks up tickets, generates code, and pushes changes for review.

**Step 1 — Add a Copilot integration**
- Go to **Integrations** → **Add** → select **GitHub Copilot** (category: AI Agent)
- Click **Authenticate with GitHub** → complete the OAuth device flow
- **Test** → **Save** → **Enable**

**Step 2 — Add a ticket source integration**
- Go to **Integrations** → **Add** → select **Redmine** or **GitLab Issues**
- *Redmine*: fill in `URL` and `API key`
- *GitLab Issues*: fill in `Base URL`, choose `Authentication Mode`
- `OAuth` recommended: enter `OAuth Client ID` + `OAuth Client Secret`, click **Connect with GitLab**, then **Test**
- `Personal Access Token` fallback: enter the token manually, then **Test**
- **Test** → **Save** → **Enable**

**Step 3 — Add a VCS / code review integration**
- Go to **Integrations** → **Add** → select **Gerrit** or **GitLab Merge Requests**
- *Gerrit*: fill in `URL` and credentials (`HTTP password` or SSH-only config, depending on your setup)
- *GitLab Merge Requests*: fill in `Base URL`, choose `Authentication Mode`
- `OAuth` recommended: enter `OAuth Client ID` + `OAuth Client Secret`, click **Connect with GitLab**, then **Test**
- `Personal Access Token` fallback: enter the token manually, then **Test**
- **Test** → **Save** → **Enable**

**Step 4 — Create an agent in the Agents Library**
- Go to **Agents Library** → **Add**
- Name the agent, set type **Coding**, pick your Copilot integration, choose model (`auto` recommended)
- Set **Max concurrent** (e.g. `2`) → **Save**

**Step 5 — Create a project**
- Go to **Projects** → **Add** → set type **Coding**, select the agent from step 4
- **Ticket source**: choose your ticket integration + project key (e.g. `PLATFORM`)
- **Push targets**: add the VCS integration, set repo key, clone URL, and target branch
- **Save** → **Enable**

Assign a ticket to `virtual-engineer` in your ticket system. The orchestrator picks it up within one polling interval and runs: `DETECTED → CONTEXT_BUILDING → AGENT_RUNNING → IN_REVIEW → MERGED → DONE`.

---

### Code review flow

The orchestrator reviews every patchset and posts inline comments automatically — no ticket system needed.

**Step 1 — Add a Copilot integration** *(same as coding step 1)*

**Step 2 — Add a Gerrit or GitLab MR integration** *(same as coding step 3; GitLab now supports OAuth-first auth with PAT fallback)*

**Step 3 — Create an agent in the Agents Library**
- Go to **Agents Library** → **Add**
- Name the agent, set type **Review**, pick your Copilot integration, choose model
- **Save**

**Step 4 — Create a project**
- Go to **Projects** → **Add** → set type **Review**, select the agent from step 3
- **Push targets**: add the Gerrit / GitLab MR integration with the repo's clone URL
- **Save** → **Enable**

**Step 5 — Wire up event delivery**
- *Gerrit*: the orchestrator connects via SSH stream-events automatically when the integration is enabled — no webhook needed.
- *GitLab*: open the integration drawer → copy the webhook URL and secret → paste into the GitLab project's webhook settings.

Every new or updated patchset triggers: `REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING → REVIEW_WATCHING → REVIEW_DONE`.

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start orchestrator + admin server |
| `npm test` | Run Vitest unit tests |
| `npm run typecheck` | Zero TypeScript errors |
| `npm run lint` | Zero ESLint errors |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run reset:instance` | Full reset (tasks, integrations, agents, projects) |
| `docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .` | Rebuild agent image after changes to `Dockerfile.agent` or `agent-worker/` |

---

## Configuration (`.env`)

Copy `.env.example` → `.env`. All provider credentials live in the DB (admin UI). The env file only contains process-level settings.

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `test` silences the logger |
| `LOG_LEVEL` | `debug` | pino levels |
| `DATABASE_PATH` | `./data/virtual-engineer.db` | |
| `ADMIN_API_HOST` | `0.0.0.0` | Use `127.0.0.1` to restrict to localhost |
| `ADMIN_API_PORT` | `3100` | |
| `ADMIN_AUTH_SECRET` | — | HMAC-SHA256 Bearer secret — recommended for exposed instances |
| `MAX_AGENT_CYCLES` | `3` | Max Copilot cycles per task before `FAILED` |
| `MAX_RETRY_ATTEMPTS` | `5` | Max times a ticket can be retried across all tasks |
| `AGENT_TIMEOUT_MS` | `1800000` | Host-side agent timeout (ms, 30 min) |
| `AGENT_CONTAINER_IMAGE` | `virtual-engineer-workspace:latest` | |
| `AGENT_DOCKER_NETWORK` | `virtual-engineer_ve-agent-net` | Bridge network for agent containers (created by `init-infra.sh`) |

---

## Full reset

```bash
npm run reset:instance
# or manually:
rm -rf data/
npm run db:migrate
npm run dev
```

---

## License

This project is licensed under **GNU GPL v3.0 only**.
See [LICENSE](LICENSE).

---

For full architecture details, component diagrams, state machine, and database schema see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
