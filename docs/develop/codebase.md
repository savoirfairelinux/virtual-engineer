# Codebase tour

Where each responsibility lives.

Where to look before changing anything.

| Name | Description |
| --- | --- |
| `src/plugins/descriptors/` | One descriptor per integration: capabilities, config schema, connection validator. |
| `src/state/` | Drizzle schema, the state machine, and transition validation. |
| `src/orchestrator/` | Polling, task start, cycle sequencing, feedback processing. |
| `src/review/` | Review trigger building, the review orchestrator, comment and vote posting. |
| `src/sandbox/` | Policy resolution, the sandbox floor, the workspace runner. |
| `agent-worker/` | What actually runs inside the sandbox. |
| `drizzle/` | Immutable migration history, hash-validated at startup. |

Reference documentation lives in the repository: [architecture and data flow](https://github.com/savoirfairelinux/virtual-engineer/blob/main/docs/ARCHITECTURE.md), [security architecture](https://github.com/savoirfairelinux/virtual-engineer/blob/main/SECURITY.md), and the [Kubernetes deployment guide](https://github.com/savoirfairelinux/virtual-engineer/blob/main/deploy/k8s/README.md).
