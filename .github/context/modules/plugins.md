# Modules — Plugins

**Source:** [src/plugins/](../../../src/plugins/).

The plugin system decouples orchestration from concrete connectors and adapters. One unified **provider descriptor** per `provider` declares the domain capabilities it can fulfil; `PluginManager` instantiates the enabled rows from `integrations`. Each descriptor is self-contained: adding a new provider requires only a new descriptor file and one line in `init.ts` — no changes to `index.ts` or `pluginManager.ts`.

## Layout

```text
src/plugins/
  init.ts          # registers built-in provider descriptors
  pluginManager.ts # active-instance bookkeeping + test hooks
  registry.ts      # descriptor registry helpers + ProviderDescriptor interface
  descriptors/
    index.ts           # buildBuiltinDescriptors() — aggregates the built-in descriptors
    copilot.ts
    claude.ts          # Claude Code agent_execution provider
    claudeOAuth.ts     # Claude Pro/Max subscription OAuth (auth-code + PKCE)
    aider.ts           # Aider agent_execution provider (wraps any litellm backend)
    gerrit.ts
    github.ts          # github-issue + github-pull-request merged
    githubOAuth.ts     # GitHub OAuth device-flow helper
    gitlab.ts          # gitlab-issue + gitlab-merge-request merged
    gitlabOAuth.ts     # GitLab OAuth helpers: device flow (RFC 8628, currently wired) + redirect/PKCE flow
    mock.ts
    redmine.ts
```

Provider ids are `github | gitlab | gerrit | redmine | copilot | claude | aider | mock` (`PROVIDER_IDS` in `src/interfaces.ts`). The former split descriptors (`github-issue` + `github-pull-request`, `gitlab-issue` + `gitlab-merge-request`) were merged into single `github` / `gitlab` descriptors. `PLUGIN_CATEGORIES` / `category` no longer exist.

A descriptor (`ProviderDescriptor`) provides:

- `provider` (the `ProviderId`) and `name`
- a `capabilities` map keyed by **domain capability** (`DOMAIN_CAPABILITIES` = `issue_tracking`, `code_review`, `source_control`, `agent_execution`) with capability factories:
  - `capabilities.issue_tracking.{ createConnector(config, integration, context?), intake? }`
  - `capabilities.code_review.{ createConnector?, createReviewer?, streamEvents?, systemPromptId?, userPromptId?, intake? }`
  - `capabilities.source_control.createVcsConnector(config, integration, context?)`
  - `capabilities.agent_execution.createAdapter?(config, integration, context?)` (optional). Agent adapters are **descriptor-driven**: a provider that declares `capabilities.agent_execution.buildAdapter(context)` is instantiated by `PluginManager` from an `AgentAdapterContext`. `PluginManager.registerFactory` remains as an explicit test/extension hook and takes precedence when used; production startup does not register overrides. Copilot, Claude, Aider, and Mock all expose this capability.
- Zod `configSchema` plus `requiredFields` UI metadata (with conditional visibility via `dependsOn`)
- optional `oauth` metadata + `createOAuthHandler` / `resolveOAuthConfig` for dashboard-driven provider auth flows (`mode: "device" | "redirect"`)
- optional `discoverResources(config)` discovery hook
- optional `discoverBranches(config, repoKey)` hook returning the branch names of one repository (Gerrit via `git ls-remote`, GitLab via `/repository/branches`, GitHub via `/repos/:fullName/branches`). Powers the on-demand `GET /api/admin/integrations/:id/branches` endpoint used by project push-target / review forms.
- optional `testConnection(config)` lightweight connectivity check
- `getSummaryDetails(config)` for the admin provider summary panel

Technical (non-domain) capabilities are **derived**, not declared: `getProviderTechnicalCapabilities(descriptor)` returns `oauth` (when `descriptor.oauth`), `discovery` (when `discoverResources`), `stream-events` (when `capabilities.code_review.streamEvents`), and `reviewer` (when `capabilities.code_review.createReviewer`). `getProviderDomainCapabilities(descriptor)` returns the keys of `capabilities`. `getPluginCapabilities(descriptor)` combines both for the admin UI.

The `context` argument on capability factories carries VE project-owned binding data such as `ticketProjectKey` or `repoKey` when runtime code needs a project-scoped connector instead of the integration-global active instance.

GitLab descriptors treat project selection as VE-project-owned rather than integration-owned. Add Integration forms are provider-scoped (`baseUrl`, auth, webhook secret, Git author defaults), while coding/review project setup supplies the concrete GitLab binding through `ticketProjectKey` (issue_tracking `config_json`) or `repos` (code_review `config_json`). GitLab Issues use built-in workflow label defaults (`in-progress`, `in-review`) unless a legacy row still carries explicit overrides.

Factories receive the stripped config (Zod defaults removed for keys absent in the raw DB row) plus the full `Integration` row. Descriptor hooks are the production construction and connection-testing path. Explicit `registerFactory` / `registerConnectionTester` hooks remain available for tests and embedders and take precedence when registered.

## Resolution rules

1. `registerBuiltinPlugins()` loads the built-in provider descriptors.
2. `PluginManager.loadFromDatabase()` reads enabled integration rows sorted by newest `updated_at` first.
3. Every enabled integration row is instantiated and kept active in memory, including multiple rows of the same **provider**.
4. Runtime code resolves connectors and metadata by `integrationId` (`getConnectorForIntegration`, `getActiveIntegrationById`, `isIntegrationActive`) or by capability/provider:
   - `getConnectorForCapability<T>(integrationId, capability)` — the connector for a specific domain capability
   - `getActiveIntegrationsByCapability(capability)` — active integrations whose provider supports the capability
   - `getActiveIntegrationsByProvider(provider)` — active integrations for one provider id
   - `providerSupportsCapability(provider, capability)` — capability lookup against the descriptor
   - `integrationSupportsCapability(integrationId, capability)` — per-integration capability check (active **and** descriptor-declared)
   - `getIntegrationCapabilityIntake(integrationId, capability)` — the intake mechanisms an active integration uses for a capability
   - `integrationHasStreamEvents(integrationId)` — checks `capabilities.code_review.streamEvents`
5. Project-mode runtime paths may either reuse the active integration-global connector via `getConnectorForIntegration(integrationId)` or build a project-bound connector via `createConnectorForIntegration(integrationId, context)` when the VE project owns part of the provider binding.
6. Active Copilot integrations are instantiated only from explicit token-bearing integration config plus the app-level default model; project Agent records remain the place where per-agent Copilot models are selected.
7. Review runtime paths resolve the active review backend by `integrationId` or by scanning active `code_review` integrations whose descriptor declares `createReviewer`; generic orchestration layers must not special-case Gerrit.
8. Older per-type helpers have been removed; resolve only by `integrationId`, capability, or provider.

## Event-intake mechanisms

New work reaches VE through three intake mechanisms, declared per capability via the descriptor's `intake` field (`getCapabilityIntake(descriptor, capability)` / `PluginManager.getIntegrationCapabilityIntake(integrationId, capability)`). All three tag tasks with the same canonical `<provider>:<integrationId>` source label (see `src/utils/ticketSourceLabel.ts`) so failure counts, footers, and integration resolution are intake-agnostic.

| Mechanism | How it works | Drivers |
|---|---|---|
| **polling** | `PollingLoop` periodically queries provider APIs (`pollProjectTickets()` for issue_tracking, `pollReviewProjects()` for code_review — skipped when the integration `integrationHasStreamEvents`). | `src/orchestrator/pollingLoop.ts` |
| **webhook** | The provider POSTs events to the per-integration webhook receiver; HMAC secret (`configJson.webhookSecret`) authenticates. | `src/webhooks/` + `PROVIDER_HANDLERS` in `src/webhooks/handlers/index.ts` |
| **stream** | VE holds a long-lived connection (Gerrit `ssh gerrit stream-events`), one listener per active integration. | `descriptor.capabilities.code_review.streamEvents` + `src/connectors/integrationStreamEvents.ts` |

Per-provider intake:

| Provider | issue_tracking | code_review |
|---|---|---|
| redmine | polling + webhook | — |
| gitlab | polling + webhook | polling + webhook (+ reviewer) |
| github | polling + webhook | polling + webhook (+ reviewer) |
| gerrit | — | stream |
| copilot / claude / aider / mock | — (agent_execution only) | — |

All provider configuration lives in `integrations` database rows managed via the admin UI. Copilot integrations currently persist an OAuth session token on the integration row; per-agent model choice still lives on the `agents` table. The unified GitLab descriptor exposes a shared `authMode = oauth | pat` surface: PAT keeps using the visible `token` password field, while OAuth writes the same hidden `token` field only after the device flow completes. GitLab OAuth uses Device Authorization Grant (RFC 8628): the dashboard renders the user code and verification URI returned by `POST /api/admin/plugins/:type/oauth/device-code`, polls `POST /api/admin/plugins/:type/oauth/token` until the user authorises the app, and writes the resulting access token to the `token` field. Two GitLab modes are supported: **gitlab.com** uses the pre-configured VE OAuth app client ID (`GITLAB_COM_VE_CLIENT_ID` constant in `gitlabOAuth.ts`; empty string disables this mode until populated); **self-hosted** requires both `baseUrl` and `oauthClientId` to be supplied in the form. User-facing GitLab integration forms therefore no longer expose OAuth app credentials, GitLab project IDs, or GitLab workflow label fields; those bindings now come from the VE project configuration (`ticketProjectKey`, push-target `repoKey`, code_review `repos`). Legacy GitLab rows created before `authMode` existed are surfaced back to the dashboard as `pat` so edit forms remain backward-compatible. Descriptor-driven OAuth flows are mounted under `/api/admin/plugins/:type/oauth/*`, with `device-code`/`token` reserved for device flows and `start`/`complete` reserved for redirect flows, so the dashboard and admin server no longer special-case Copilot routes.

The dashboard's add-integration modal picks a **provider** (not a role) and filters by descriptor domain capabilities, so one provider that exposes multiple capabilities appears once and is grouped by provider in the Integrations section.
The dashboard also collects only visible descriptor fields when testing, saving, or starting an OAuth flow, so values hidden by `dependsOn` do not leak into payloads after an operator switches auth mode.

## Hot refresh

`PluginManager.onPluginChange()` is wired in [src/index.ts](../../../src/index.ts). Integration changes trigger `refreshRuntimeDependencies()`, which updates the workspace runner, orchestrator, polling loop, review trigger, generic integration stream managers, and admin runtime summaries in place.

## Connection testing

`POST /api/admin/integrations/test` validates an unsaved form payload without persistence.

- Copilot uses `copilotConnectionValidator` and may return discovered `models`
- Copilot test-connection reads the hidden `sessionToken` field when present
- Gerrit uses SSH-based checks and discovery; `baseUrl` is optional and only used for web links
- GitLab and Redmine perform lightweight authenticated HTTP checks
- edit-mode tests merge masked / omitted secrets from the stored row first

## Tests

- `tests/unit/registry.test.ts`
- `tests/unit/pluginManager.test.ts`
- `tests/unit/pluginManager.multiInstance.test.ts`
- `tests/unit/runtimeBootstrap.test.ts` (historical filename; covers runtime bootstrap and fallback wiring in `src/index.ts`)
- `tests/unit/integrationStreamEvents.test.ts`
- `tests/unit/integrationStore.test.ts`
- `tests/unit/promptStore.test.ts`

## Adding a descriptor

1. Create `src/plugins/descriptors/<provider>.ts` declaring a `capabilities` map; implement the relevant capability factories (`issue_tracking.createConnector`, `code_review.createConnector` / `createReviewer`, `source_control.createVcsConnector`, `agent_execution.createAdapter`) plus `testConnection` and `getSummaryDetails`.
2. If the provider can drive VE code review, set `capabilities.code_review.systemPromptId` / `userPromptId` and implement `createReviewer`.
3. Register it in `registerBuiltinPlugins()` ([src/plugins/init.ts](../../../src/plugins/init.ts)).
4. Add or update connection tests and admin discovery coverage.

No changes to `src/index.ts`, `pluginManager.ts`, or `vcsFactory.ts` are needed. Agent providers that need host runtime values such as the Docker network or commit limit receive them through `AgentAdapterContext` in `buildAdapter(context)`.

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [connectors.md](connectors.md) — ticket / review connectors produced by descriptor factories
- [vcs.md](vcs.md) — host-side push layer
- [agents.md](agents.md) — agent adapters built via `agent_execution` capability
- [admin.md](admin.md) — admin API that hot-refreshes runtime dependencies
