# FAQ

Recurring operational questions.

## Can we run it fully self-hosted?

Yes. The orchestrator, SQLite database, OpenShell gateway, and sandboxes all run on your infrastructure. Keep the Admin UI on loopback or behind a trusted reverse proxy.

## What happens if a cycle crashes mid-run?

SQLite runs in WAL mode and the state machine is persisted, so coding tasks resume at their last recorded state after a restart. AGENT_RUNNING restarts from scratch, since the sandbox is ephemeral.

## Can the agent merge its own changes?

No. It proposes changes and votes on review; merging follows your existing branch protection.

## Can we run several engines at once?

Yes. Multiple active integrations of the same provider run in parallel, and each agent selects its own engine and model.

## How do we report a vulnerability?

Privately, to contact@savoirfairelinux.com rather than a public issue. Reports are acknowledged within 48 hours and assessed within 7 days.
