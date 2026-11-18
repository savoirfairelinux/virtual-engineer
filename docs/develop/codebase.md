# Codebase tour

Where each responsibility lives.

Where to look before changing anything.

| Name | Description |
| --- | --- |
| `src/plugins/descriptors/` | One descriptor per integration: capabilities, config schema, connection validator. |
| `src/state/` | Drizzle schema, the state machine, and transition validation. |
| `src/orchestrator/` | Polling, task start, cycle sequencing, feedback processing. |
| `src/review/` | Review trigger building, the review orchestrator, comment and vote posting. |
| `src/connectors/` | Ticket and review connectors, and the Gerrit stream-events listener. |
| `src/vcs/` | Host-side clone, push, and merge or pull request creation per provider. |
| `src/webhooks/` | The inbound webhook receiver and its per-provider handlers. |
| `src/agents/` | One adapter per engine: sandbox spec, connection validation, model catalog. |
| `src/workspace/` | The host Git executor, skill installation, and the workspace runner. |
| `src/openshell/` | The gateway client, policy resolution, the sandbox floor, denial parsing. |
| `src/admin/` | The Admin API, authorization, and the dashboard. |
| `agent-worker/` | What actually runs inside the sandbox. |
| `drizzle/` | Immutable migration history, hash-validated at startup. |

Reference documentation lives in the repository: the [module-level context index](https://github.com/savoirfairelinux/virtual-engineer/blob/main/.github/context/INDEX.md), [security architecture](https://github.com/savoirfairelinux/virtual-engineer/blob/main/SECURITY.md), and the [Kubernetes deployment guide](https://github.com/savoirfairelinux/virtual-engineer/blob/main/deploy/k8s/README.md).
