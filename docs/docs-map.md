# All pages

The complete page index.

## Get started

- [Requirements](start/requirements.md) — What the host needs before you install.
- [Install](start/install.md) — The one-line installer and its pinning options.
- [Install from source](start/install-source.md) — Existing checkout, .env, and start.sh.
- [First project](start/first-project.md) — From an assigned ticket to a change under review.
- [First review project](start/first-review.md) — Review incoming patchsets with no issue tracker.

## Concepts

- [Architecture](concepts/architecture.md) — Orchestrator, gateway, sandbox, database.
- [Tasks and cycles](concepts/tasks.md) — The unit of work, and how many times it may run.
- [Task states](concepts/states.md) — One state machine for both workflows.
- [The two workflows](concepts/workflows.md) — code-gen and code-review, side by side.
- [Capabilities and bindings](concepts/capabilities.md) — Why the workflow never names a provider.
- [Prompts](concepts/prompts.md) — System, instructions, and the per-cycle user prompt.
- [Trust boundaries](concepts/trust.md) — What the host holds and what the sandbox sees.

## Guides

- [Configure a project](guides/configure-project.md) — Repository, branch, bindings, agent.
- [Add an integration](guides/add-integration.md) — Credentials, validation, and hot refresh.
- [Choose an agent engine](guides/choose-engine.md) — Pick by credential and model catalog.
- [Tune review output](guides/tune-review.md) — Bound comments and raise the severity floor.
- [Multi-repo workspaces](guides/multi-repo.md) — Scan manifests and classify members.
- [Push targets and reviewers](guides/push-targets.md) — Commit order and per-provider reviewer rules.
- [Author a prompt](guides/author-prompt.md) — Clone a built-in and bind the clone.
- [Install skills](guides/skills.md) — Per-engine skill directories, installed host-side.

## Hubs

- [Sandbox](hubs/sandbox.md) — Runtime policy, lifecycle, egress, and paths.
- [Security](hubs/security.md) — Credentials at rest, exposure, audit, disclosure.
- [Review](hubs/review.md) — Ingestion, bounds, and routing guarantees.
- [Agent engines](hubs/engines.md) — All eight engines, their auth and their models.
- [Providers](hubs/providers.md) — The four external systems and their quirks.
- [Observability](hubs/observability.md) — Transitions, cost, and live logs.

## Reference

- [Environment variables](reference/ref-config.md) — Every variable, its default and its effect.
- [System settings](reference/ref-settings.md) — Runtime-editable limits in app_settings.
- [States and transitions](reference/ref-states.md) — The complete edge list.
- [Sandbox policy schema](reference/ref-policy.md) — Fields of the resolved runtime policy.
- [Glossary](reference/glossary.md) — One term per concept.

## Operations

- [Debug a task](operations/debug.md) — Read the transition log and what it implies.
- [Troubleshooting](operations/troubleshooting.md) — Symptom, cause, fix.
- [FAQ](operations/faq.md) — Recurring operational questions.

## Develop

- [Local setup](develop/dev-setup.md) — Run the orchestrator from a checkout.
- [Codebase tour](develop/codebase.md) — Where each responsibility lives.
- [Migrations](develop/migrations.md) — Immutable history, fail-closed runner.
- [Writing docs](develop/contributing-docs.md) — Rules this documentation follows.

## Project

- [Credits and license](project/credits.md) — Maintainers, license, security contact.
