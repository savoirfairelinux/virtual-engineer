# Database Context

## Agent Prompt References

- `agents.system_prompt_id` and `agents.instructions_prompt_id` are nullable foreign keys at the SQLite schema level, but the store and admin API require both for every create/update.
- `prompts.prompt_type` is the prompt's runtime role: `system | instructions`, with `instructions` as the database default. The user prompt is generated per cycle from the ticket or review and is not a stored prompt type.
- New agents cannot be created through the admin API without both references. Each ID must resolve to an existing `prompts` row with the matching role, and updates cannot clear either reference.
- Runtime resolution is fail-closed: agents missing either prompt, referencing a missing prompt, or crossing the `system` / `instructions` roles do not receive a generic or integration-specific fallback.
- Fresh databases seed exactly five built-ins: `system_generic_code`, `instructions_generic_code`, `instructions_feedback_code`, `system_review`, and `instructions_review`. Provider-specific aliases and alias override files are not seeded or migrated.
- Startup preserves unknown prompt rows, normalizes unsupported stored roles to `instructions`, and derives referenced roles from existing agent and project-override references. A prompt referenced in both roles is cloned for the instructions side and those references are repointed without changing content; prompt hydration also defensively maps any unsupported role to `instructions`, and obsolete `user_*_review.md` files are ignored.

## Resource Ownership

- `projects`, `integrations`, `agents`, `prompts`, and `oauth_apps` have a nullable, indexed `owner_user_id` foreign key to `users.id`. New admin-API resources store the authenticated creator; built-ins and rows predating ownership keep NULL.
- NULL is the explicit legacy/shared state and is readable through the `Registered Users` system policy. A non-NULL resource is visible only to its owner, an explicit user/group policy scope, a delegated project owner (projects/tasks), or the admin superuser.
- Ownership foreign keys use SQLite `NO ACTION`: a user that still owns resources cannot be deleted until those resources are deleted or reassigned. `deleteUser` wraps session/binding/user removal in one transaction and the admin API maps the FK conflict to 409, so a failed deletion performs no partial cleanup and cannot turn private rows into legacy-public rows.
- Tasks do not duplicate ownership. `tasks.project_id` identifies the parent project, and all `task.*` authorization resolves against that project's ownership and policy scope. OAuth app policy resource IDs use the normalized composite key `provider|baseUrl`; the table primary key remains `(provider, base_url)`.
- `createProject`, `createAgent`, `createPrompt`, `upsertIntegration`, and `upsertOAuthApp` accept an optional owner for legacy/internal callers. Store hydration normalizes persisted owners to `string | null`, and update paths preserve the existing owner.

## Project Integration Bindings

`project_integration_bindings.config_json` stores capability-specific JSON. The
`code_review` shape is `{ repos: string[], assignmentMode?: "manual" | "automatic" }`.
The project store normalizes an absent or invalid `assignmentMode` to `manual`;
no SQL column or migration is required. `automatic` means the reviewer provider
adds VE idempotently on revision events, while initial open-change backfill is
disabled. Mode changes are execution-affecting and are rejected while the
project has active tasks.

`ProjectStoreApi.getEventStreamDemand()` is an on-demand aggregate over existing
project bindings, tasks, push targets, and per-repository changes; it adds no
schema or migration. Enabled review projects request their `code_review`
integration immediately. Coding push targets request a stream only while a
non-terminal task has a persisted external change, and non-terminal review
tasks retain their project's review integration even when that project is
disabled. The result separately identifies enabled review-project integrations
so runtime project changes can request a targeted assignment backfill.

## Project statistics

`getProjectStatistics(projectId, options?)` is an on-demand `StateStore` aggregate;
it adds no tables, columns, indexes, or migration. It scopes current task state,
period task creation and terminal transitions, agent cycles and validation,
creation-to-terminal timing, and cost/model summaries through `tasks.project_id`.
The optional `since` bound uses the existing seconds-since-epoch timestamps, and
the optional live-concurrency value is supplied by the in-memory tracker rather
than persisted. Cost and token values preserve the existing distinction between
measured zero and missing provider usage.

## Projects Skill Columns

- `projects.skill_sources_json` is a non-null text JSON column with default `[]`. It stores optional project-configured external skill sources. The empty value is the database/API default; the admin UI's new-project form preloads the SFL `agent-skills` SSH source with `installAll: true`, so saving that untouched form persists a non-empty value. `OpenShellWorkspaceRunner` calls `skillSourceInstaller.ts` to fetch and install configured sources **host-side**, before the workspace is uploaded to the sandbox, so the resulting skill files reach the sandbox without any SSH material ever entering it (see [modules/workspace.md](modules/workspace.md#external-skill-sources)).
- Repository skill discovery is provider-owned and is not project configuration. The former `projects.skill_discovery_enabled` and `projects.local_skills_path` columns are removed, and the admin API rejects both deleted request fields.

## Project Push Targets

- `project_push_targets.reviewer_emails` is a non-null text column containing a JSON string array, defaulting to `[]`. Gerrit receives one `r=<email>` push option per address, while GitLab resolves visible `email` or `public_email` values to numeric `reviewer_ids` and updates an existing MR when necessary.
- The admin API trims and lowercases addresses, removes case-insensitive duplicates, and accepts at most 20 per target. Reviewer emails are supported only for Gerrit and GitLab push targets; GitHub requires usernames and rejects non-empty reviewer-email configuration.
- `addProjectPushTarget` and `replaceProjectPushTargets` JSON-encode reviewer emails on write. `listProjectPushTargets` returns parsed string arrays and safely falls back to `[]` for malformed legacy values.

## Project Vendor Components

- `project_vendor_components` (INTEGER `id` PK) persists workspace-scanned third-party components of a coding project: `project_id` (FK → `projects.id`), `source_path` (NOT NULL, the real manifest path in the checkout), nullable `local_path` / `clone_url` / `revision`, `origin`, and timestamps. The table holds only components no repository of ours owns; one that we do own becomes a `project_push_targets` row instead. `replaceProjectVendorComponents()` deletes and reinserts the project's rows in one transaction but carries the previous `created_at` over for any `(source_path, local_path)` pair that survives the replace, so the column keeps meaning "first tracked".
- `origin` is one of `internal | fork_pushable | patch_required | ambiguous` (see `VendorComponentOrigin` in `src/interfaces.ts`) and records whether VE can push to the component or must patch it locally.
- `uq_pvc_project_source_local` is the identity over `(project_id, source_path, NULL-normalized local_path)`. The SQLite expression uses `CASE WHEN local_path IS NULL THEN '' ELSE local_path END`, which is equivalent to `COALESCE(local_path, '')` but remains compatible with the pinned drizzle-kit generator. One manifest routinely declares several components — every kas layer of a Yocto workspace is declared by the same `.config.yaml` — so the declaring path alone would collapse them into a single row.
- `replaceProjectVendorComponents` deletes and re-inserts in one transaction, so a rejected batch leaves the previous set intact; `listProjectVendorComponents` orders by `source_path`. `deleteProject` removes the project's rows.

## Migration Path

- `src/state/schema.ts` is the declarative schema source. `npm run db:generate` writes immutable SQL plus metadata under the version-controlled `drizzle/` directory; every schema, index, or constraint change must commit a newly generated migration. Never edit an already-applied migration.
- Ownership is introduced by `0003_sad_nuke.sql`: it adds `owner_user_id` and an owner index to prompts, projects, integrations, agents, and OAuth apps. Existing rows remain NULL, preserving the approved legacy-visible behavior. The migration follows the frozen two-migration compatibility bridge and is applied only by the normal Drizzle runner.
- `runDatabaseMigrations()` in `src/state/databaseMigrations.ts` is the single executor used by automatic startup and `npm run db:migrate`. It applies tracked files with `drizzle-orm/better-sqlite3/migrator` and records exact SQL hashes and journal timestamps in `__drizzle_migrations`.
- Fresh databases apply the tracked baseline directly. Ledger-managed databases validate their recorded hashes/timestamps against the checked-in history before pending migrations run; unknown or modified history fails closed. Every run then compares the complete SQLite schema and trigger definitions with a temporary canonical database built from the tracked migrations and runs `PRAGMA foreign_key_check`.
- Databases created before the Drizzle ledger are recognized only by known Virtual Engineer table signatures. A frozen compatibility bridge upgrades their legacy columns/indexes and prompt data, validates column types/nullability/defaults/PKs, indexes and expressions, foreign keys/actions, CHECK constraints, triggers, and physical composite uniqueness against that canonical database, then stamps the baseline atomically. Legacy comparison normalizes SQLite's implicit `INTEGER PRIMARY KEY` nullability and ignores physical column ordinals in otherwise equivalent indexes. Actual columns absent from the canonical schema fail adoption unless they are explicitly retired: `projects.skill_discovery_enabled`, `projects.local_skills_path`, or `project_vendor_components.note` / `integration_id` / `repo_key`. Canonical table rebuilds preserve existing `sqlite_sequence` high-water marks. Arbitrary ledgerless databases are rejected, and a failed adoption leaves no ledger or partial upgrade.
- The one-time bridge preserves the former upgrades: it converts `project_ticket_source` rows into `issue_tracking` bindings and `project_review_integration` plus sorted, deduplicated `project_review_repos` rows into `code_review` bindings before dropping those predecessor tables. Review-repository rows without a corresponding predecessor integration and review integrations without an existing project fail adoption instead of being discarded. Canonical triggers are installed only after the ledger table exists, then included in final validation. The bridge also creates `project_vendor_components`, removes the two retired project skill columns, adds `reviewer_emails`, `app_settings.agent_timeout_ms`, `app_settings.ticket_close_max_retries`/`ticket_close_retry_min_timeout_ms`, and normalizes/clones prompt roles via `ensureLegacyColumns()`/`migrateReferencedPromptRoles()`. Binding conversion and baseline adoption share one transaction, so malformed predecessor shapes or binding conflicts roll back without overwriting data. Future schema changes belong only in new tracked migrations, never in the bridge.
- `backfillLegacyCycleCosts()` (`src/state/databaseMigrations.ts`) runs on every `runDatabaseMigrations()` call (i.e. every process start, both automatic startup and `npm run db:migrate`) and recomputes/persists missing `agent_cycles` cost columns. It covers both rows where all 8 snapshot columns are NULL and recoverable historical partial snapshots whose four token columns are all NULL even though cost/model values already exist; SQLite JSON inspection restricts partial candidates to events with numeric token fields so normal tokenless cycles are not reparsed on every startup. It scans in bounded batches (500 rows/query, cursor on `id`) rather than materializing the whole legacy result set, validates `agent_events` as an event array first, falls back to `agent_result`'s embedded `agentEvents` when the primary source lacks the data required by the backfill, and writes via `computeCycleCost()`/`hasCostData()` using the same mapping as `saveAgentCycle()`. Existing non-NULL cost/model values remain authoritative (`COALESCE` on update). Token columns remain NULL when no finite token field was reported; if a provider reports all-zero token metrics, all four columns persist as zero so aggregates can distinguish measured zero from unmeasured usage. Rows with no recoverable event log are left untouched. This is the **only** place cost is ever recomputed from event JSON: `getCostSummary()`/`getModelUsageSummary()` (`src/state/stores/costStore.ts`) and `getAgentCycles()` (`src/state/stores/taskStore.ts`) read the snapshot columns directly with no read-time fallback.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [state-machine.md](state-machine.md) — `state_transitions` rows and pause/resume
- [configuration.md](configuration.md) — `app_settings` (DB-managed workflow settings)
- [copilot-instructions.md](../copilot-instructions.md) — always-loaded schema invariants (`task_id`, second-based timestamps, migration rules)
- [ve-debug skill](../skills/ve-debug/SKILL.md) — SQLite query recipes for debugging
