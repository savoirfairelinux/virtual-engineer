# Architecture

Orchestrator, gateway, sandbox, database.

The orchestrator always runs on the host. The agent never does. Everything an agent touches is an ephemeral sandbox that is destroyed when its cycle exits, along with the host scratch workspace.

```
ticket source integration
  → PollingLoop.pollProjectTickets()
  → Orchestrator.startTaskForProject()
  → OpenShellWorkspaceRunner
      host clone → sandbox create → upload
      → post-clone hook → exec → download
  → agent-worker in the sandbox → AgentResult
  → host-side VCS push → review system
  → webhook feedback → Orchestrator
```

## Components

- **Orchestrator** — a TypeScript process on the host. Owns polling, state, Git plumbing, and credentials.
- **OpenShell gateway** — creates and destroys sandboxes through a compute driver, and enforces runtime policy.
- **Agent worker** — runs inside the sandbox at `/app/agent-worker/`, with the workspace at `/sandbox/<repo>`.
- **SQLite** — one file, WAL mode. State, integrations, prompts, cycles, and cost.
- **Admin UI** — the only configuration surface, served on loopback by default.

Read [Trust boundaries](trust.md) next: it is the constraint that explains most of this shape.
