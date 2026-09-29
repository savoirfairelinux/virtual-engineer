# Database Context

## Agent Prompt References

- `agents.system_prompt_id` and `agents.instructions_prompt_id` are nullable foreign keys at the SQLite schema level, but the store and admin API require both for every create/update.
- `prompts.prompt_type` is the prompt's runtime role: `system | instructions`, with `instructions` as the database default. The user prompt is generated per cycle from the ticket or review and is not a stored prompt type.
- New agents cannot be created through the admin API without both references. Each ID must resolve to an existing `prompts` row with the matching role, and updates cannot clear either reference.
- Runtime resolution is fail-closed: agents missing either prompt, referencing a missing prompt, or crossing the `system` / `instructions` roles do not receive a generic or integration-specific fallback.
- Fresh databases seed exactly five built-ins: `system_generic_code`, `instructions_generic_code`, `instructions_feedback_code`, `system_review`, and `instructions_review`. Provider-specific aliases and alias override files are not seeded or migrated.
- Built-ins remain shared NULL-owner templates, not per-user copies. The admin API rejects their modification/deletion; existing startup override files remain supported for compatibility. Creating a private copy uses normal `createPrompt` with the caller as owner and never repoints existing agents automatically.
- `createPrompt` generates opaque `prompt-<UUID>` ids independent of labels, allowing the same label within or across accounts. Existing ids and references are preserved without a schema migration. Internal `upsertPrompt` retains its existing startup/fixture behavior; admin edits only reach it for non-built-in ids.
- Startup preserves unknown prompt rows, normalizes unsupported stored roles to `instructions`, and derives referenced roles from existing agent and project-override references. A prompt referenced in both roles is cloned for the instructions side and those references are repointed without changing content; prompt hydration also defensively maps any unsupported role to `instructions`, and obsolete `user_*_review.md` files are ignored.

## Resource Ownership

- `projects`, `integrations`, `agents`, `prompts`, and `oauth_apps` have a nullable, indexed `owner_user_id` foreign key to `users.id`. New admin-API resources store the authenticated creator; built-ins and rows predating ownership keep NULL.
- NULL is the explicit legacy/shared state and is readable through the `Registered Users` system policy. A non-NULL resource is visible only to its owner, an explicit user/group policy scope, a delegated project owner (projects/tasks), or the admin superuser.
- Ownership foreign keys use SQLite `NO ACTION`: a user that still owns resources cannot be deleted until those resources are deleted or reassigned. `deleteUser` wraps session/binding/user removal in one transaction and the admin API maps the FK conflict to 409, so a failed deletion performs no partial cleanup and cannot turn private rows into legacy-public rows.
- Tasks do not duplicate ownership. `tasks.project_id` identifies the parent project, and all `task.*` authorization resolves against that project's ownership and policy scope. OAuth app policy resource IDs use the normalized composite key `provider|baseUrl`; the table primary key remains `(provider, base_url)`.
- `createProject`, `createAgent`, `createPrompt`, `upsertIntegration`, and `upsertOAuthApp` accept an optional owner for legacy/internal callers. Store hydration normalizes persisted owners to `string | null`, and update paths preserve the existing owner.

## User Roles and Policies

- `updateUser` reads the current user, changes the role, replaces direct built-in `Operator`/`Viewer` bindings when needed, and captures its result in one immediate transaction. Concurrent changes cannot compare against a stale pre-transaction role or return another update's result. Custom direct bindings and group memberships are preserved; admin accounts need no default policy binding. Changing only account availability does not reset policy choices.
- `updateUser` and `deleteUser` re-check the admins inside their immediate transaction: demoting, disabling, or deleting the last enabled admin rejects with `LAST_ADMIN`, and doing so to the last enabled admin without a `user_identities` link rejects with `LAST_LOCAL_ADMIN`.
- `createSession` accepts an optional `identityId`; when present, the session is inserted in an immediate transaction only while that is still the user's `user_identities` link (`null` = no link) and otherwise rejects with `IDENTITY_CHANGED`, so a login racing a link or unlink cannot issue a session. In the same transaction, a directory session is refused with `SOURCE_DISABLED` while the link's `auth_sources.enabled` is 0.
- Effective permissions impose a read-only ceiling on `viewer`, including resource ownership and explicit user/group grants. Delegated project/task reads remain available, but mutation and access delegation do not. Self-service password changes and logout remain authenticated operations.
- The seeded `Operator` policy no longer grants `system.write`. Administrators retain full access; an operator needs an explicit policy grant to change instance settings. Built-in policy rules are refreshed at startup.

## Task Ticket-Source Snapshot

- `tasks.ticket_source_integration_id` and `tasks.ticket_source_project_key` are nullable text snapshots of the issue-tracking binding that created a ticket task. `createTask()` writes them from its optional `ticketSource` argument, and task hydration exposes them as `ticketSourceIntegrationId` / `ticketSourceProjectKey`; legacy and non-ticket-backed rows may have NULL values. These columns already exist and are not foreign keys.
- Ticket-source snapshots remain persisted for traceability and legacy tasks. Connector resolution now follows the project's current binding so active non-terminal tasks can continue under updated project configuration; a removed binding still fails closed.

## Log context lookup

`SqliteStateStore.resolveLogContext(kind, id)` synchronously reads existing
rows by primary key for `integration`, `project`, `agent`, `user`, and `prompt`,
returning `integrationName`, `projectName`, `agentName`, `userName`, or
`promptName`. For `task`, it returns `ticketId`, `ticketTitle` (truncated to 80
characters), and, when linked, `projectId` and `projectName` via a join.
Unknown IDs or rows without readable fields return `undefined`. Statements
are prepared once per entity kind, while names are queried on every log write
to reflect edits. This read-time API adds no schema, index, or migration.

## Task soft deletion and cost history

- `tasks.deleted_at` (nullable epoch-seconds timestamp) marks tasks hidden from operational reads (`getTask`, `getAllTasks`, active/retry lookup paths) without dropping immutable historical rows.
- `getCurrentStateEnteredAt(taskIds)` returns, per task, the newest `state_transitions.created_at` whose `to_state` equals the current `tasks.state` and `from_state <> to_state` (pause/resume rows excluded), batched by 900 IDs. Tasks without such a row are omitted; callers fall back to `updated_at`, which unrelated writes can bump.
- `deleteTask(taskId)` now soft-deletes terminal tasks by setting `deleted_at` (and still removing mutable change/comment rows), so `agent_cycles` and `state_transitions` remain available for cost/model/statistics aggregates and audit history.
- `deleteTaskGroup(taskId)` delegates to the same soft-delete semantics for terminal siblings sharing ticket/change identity; it does not physically delete immutable history rows.
- Project reassignment/deletion paths (`adoptOrphanedTasksForProject`, `deleteProject`) only mutate rows with `deleted_at IS NULL`, so soft-deleted tasks keep their snapshot bindings and are never resurrected by orphan adoption.
- `getCostSummary()` and `getModelUsageSummary()` continue aggregating from preserved `agent_cycles` snapshots joined to `tasks`, so deleting a task no longer erases historical USD/token totals.
- Both summary methods accept `CycleSummaryOptions`: inclusive `since`, exclusive `before`, optional single `projectId`, and optional `projectIds` list. Project constraints intersect when both are supplied; an empty list matches no projects. Filters are parameterized in SQL before aggregation, so totals and project/model slices share the same scope. Omitting the new fields preserves existing behavior and all-time/unassigned history.
- `getReviewVoteCounts(taskIds, since?, options?)` reads numeric review scores from `agent_cycles.agent_result` with SQLite JSON functions and groups them in SQL, without hydrating full cycle payloads. `ReviewVoteOptions` adds exclusive `before` and opt-in `inclusiveSince` for UTC calendar ranges; the original strict lower cutoff remains the default. It accepts only the caller's readable review task IDs, batches IDs below SQLite's parameter limit, skips malformed JSON and non-numeric scores, and uses epoch-seconds `created_at` cutoffs. No schema or migration change is needed.
- `getProjectStatistics()` excludes `deleted_at` rows from operational task, period, execution, and timing counts to avoid resurfacing soft-deleted tasks in project health metrics.

## Admin Authentication Sources

- `auth_sources` (TEXT `id` PK) stores external credential authorities for admin login: unique `name`, `kind` (CHECK `IN ('ldap')`), `enabled` (INTEGER, default 1), `priority` (INTEGER, default 100; lower values are tried first), `config_json` (TEXT, default `{}`), `auto_provision` (INTEGER, default 0), `default_role` (TEXT, default `viewer`; the API accepts only `viewer` / `operator`), `session_max_age_hours` (INTEGER, default 24), `revalidate_interval_minutes` (INTEGER, default 15; 0 = every request), and second-based `created_at` / `updated_at`. Introduced by `0006_natural_nocturne.sql`; the provisioning columns by `0008_hot_donald_blake.sql`, the session columns by `0009_sad_sabra.sql`.
- `user_sessions.validated_at` (nullable, seconds) records the last directory confirmation of a directory session; it is NULL for local-password sessions. `UserStoreApi.createSession` accepts an optional `validatedAt`, and `markSessionValidated(tokenHash, at)` updates it (`0009_sad_sabra.sql`).
- `config_json` holds the kind-specific settings validated by `ldapConfigSchema` (`src/admin/authentication/ldapConfig.ts`): URL, StartTLS, optional CA PEM, service bind DN/password, user search base/filter, and attribute names. `bindPassword` is always stored as a `veenc:v1:` envelope; the admin API masks it and never returns ciphertext.
- `AuthSourceStoreApi` (`src/state/stores/authSourceStore.ts`): `createAuthSource`, `getAuthSourceById`, `listAuthSources` (ordered by `priority`, then `name`), `updateAuthSource`, `deleteAuthSource`. Name collisions throw `code = "DUPLICATE"`.
- `user_identities` (TEXT `id` PK) links a local user to one directory account: `user_id` (unique, FK `users.id` ON DELETE CASCADE), `auth_source_id` (FK `auth_sources.id`, no action, so a source with links cannot be deleted), `external_subject` (stable `uniqueIdAttribute` value, e.g. `entryUUID`), `external_username` (refreshed on login, best-effort), `created_at`, nullable `last_login_at`; unique `(auth_source_id, external_subject)`. Introduced by `0007_big_mongu.sql`.
- Linked users store the unusable `users.password_hash = '!external'` marker (`EXTERNAL_PASSWORD_HASH`), so local verification always fails for them without making the column nullable.
- `UserIdentityStoreApi` (`src/state/stores/userIdentityStore.ts`): `getUserIdentityByUserId`, `getUserIdentityBySubject`, `listUserIdentities`, `countUserIdentitiesForSource`, `countEnabledLocalAdmins` (enabled admins without a link), `createExternalUser` (user + link in one transaction; `DUPLICATE`), `linkUserIdentity` (link + marker + session revocation in one immediate transaction; `NOT_FOUND` / `ALREADY_LINKED` / `DUPLICATE` / `LAST_LOCAL_ADMIN`), `unlinkUserIdentity` (remove link + set local hash + revoke sessions), `recordIdentityLogin`, `deleteSessionsForAuthSource` (revoke every session of users linked to a source).
- `auth_source_group_mappings` (TEXT `id` PK) maps a normalized directory group (`external_group`) of one source (`auth_source_id`, FK ON DELETE CASCADE) to a VE group (`group_id`, FK ON DELETE CASCADE); unique `(auth_source_id, external_group, group_id)`, indexed by `group_id`.
- `user_identity_groups` (PK `(identity_id, external_group)`, `identity_id` FK `user_identities.id` ON DELETE CASCADE, `synced_at`) holds the directory groups reported at the identity's latest sign-in or admin lookup. Both tables were introduced by `0008_hot_donald_blake.sql`.
- `DirectoryGroupStoreApi` (`src/state/stores/directoryGroupStore.ts`): `listGroupMappings`, `createGroupMapping` (`DUPLICATE` / `NOT_FOUND`), `deleteGroupMapping`, `replaceIdentityGroups` (one transaction), `listIdentityGroups`, `listMappedGroupIds`, `listDirectoryMemberIds` (enabled sources only). `getEffectivePolicyRulesForUser` unions `group_members` with groups mapped from the user's identity groups through an enabled source; `group_members` itself is never written by directory sync.

## Audit trail store

- `AuditStoreApi.listAuditEntries()` supports action, actor, target-type, integration-reference, and UTC calendar-boundary filters in addition to pagination. Integration filtering matches both an integration target ID and `details_json.integrationId`; it adds no schema change.
- `AuditStoreApi.listAuditDateRange()` returns the oldest and newest audit timestamps for export defaults; an empty trail returns null bounds. It is a read-time query and adds no schema, index, or migration.
- `AuditEntryFilter.maxId` limits reads to the append-only `audit_log.id` high-water mark, and `AuditStoreApi.getLatestAuditId()` returns that mark or NULL for an empty trail. The CSV export captures the mark before paging and applies it to every page, excluding entries appended during the download without holding a long transaction; this adds no schema, index, or migration.
- `AuditStoreApi.listAuditActions()`, `listAuditActors()`, `listAuditIntegrations()`, and `listAuditTargetTypes()` read distinct audit filter options for the admin UI/export page; they add no table, column, index, or migration.

## Application Settings and Backups

- `app_settings` is the singleton row (`id = 'global'`) for editable runtime settings. The workflow columns are nullable and fall back to configuration defaults. Backup settings add nullable `backup_enabled` (SQLite integer boolean), `backup_interval_days` (integer), `backup_time_of_day` (UTC `HH:MM` text), and `backup_retention_count` (integer); `updated_at` remains a required seconds-since-epoch timestamp. The backup schedule migration adds these columns without changing existing settings.
- `SettingsStoreApi.getBackupSettings()` / `updateBackupSettings()` read and partially upsert those four values. The admin API resolves NULLs to disabled, every 1 day, `03:00` UTC, and 7 retained archives; interval and retention are bounded before persistence.
- `SqliteStateStore.backupDatabaseTo(destinationPath)` uses SQLite's online backup API, then removes active `user_sessions` from the copy and converts the snapshot to a standalone DELETE-journal database. It never cleans or checkpoints the live connection as a side effect.
- Backup archives include that SQLite snapshot and allowlisted prompt override Markdown files. New `.tar.gz.enc` archives are wrapped in AES-256-GCM using the external `BACKUP_KEYRING_FILE`; historical plaintext `.tar.gz` archives remain restorable. Manifest format v2 uses HMAC-SHA256 with `ADMIN_AUTH_SECRET` to authenticate the canonical SQLite SHA-256 and deterministically code-unit-sorted prompt-override filename/hash inventory; the secret itself is never stored. Restore authenticates/decrypts the encrypted wrapper first, then verifies the HMAC, database and prompt contents/inventory before running the normal tracked migration/schema validator and installation. Earlier v1 manifests are rejected because their checksum and prompt inventory are not authenticated. The original admin secret is also required to decrypt restored provider credentials. Active sessions, the backup keyring, OpenShell state, managed local OIDC files, and ephemeral workspaces are not included.

## Project Integration Bindings

`project_integration_bindings.config_json` stores capability-specific JSON. The
`code_review` shape is `{ repos: string[], assignmentMode?: "manual" | "automatic", branches?: string[], automaticPollingSince?: number }`.
The project store normalizes an absent or invalid `assignmentMode` to `manual`;
no SQL column or migration is required. `branches` lists exact target-branch
names, normalized on write and read (trimmed, `refs/heads/` stripped,
de-duplicated) and omitted when empty; an absent or empty list reviews every
branch. `setProjectReviewConfig(projectId, integrationId, repoKeys,
assignmentMode?, branches?)` and `updateProjectConfiguration({ reviewConfig })`
write it, `getProjectReviewConfig()` always returns `branches` (empty = every
branch), and a branch-only change is not execution-affecting.
`automaticPollingSince` is the
automatic discovery watermark in Unix seconds: it starts at the activation time
and `advanceAutomaticReviewPollingSince(projectId, expected, next)` moves it
forward with a compare-and-set after complete polls. For older automatic
bindings without that value, `initializeAutomaticReviewPollingSince(projectId)`
atomically sets it on the first poll. Unchanged automatic review bindings
preserve it across admin saves and restarts; a malformed previous binding JSON
is treated as a fresh activation. `automatic` means the reviewer provider adds VE
idempotently on revision events, including changes found by polling after
activation, while initial open-change backfill is disabled. Mode changes are
execution-affecting and persist immediately without an active-task confirmation
roundtrip.

`StateStore.updateProjectConfiguration()` returns the updated project plus an
`executionChanged` flag. Execution-affecting changes now persist immediately
without an active-task confirmation roundtrip; existing active tasks are left
untouched and pick up updated project bindings on their next connector
resolution step. `confirmedActiveTaskIds` remains accepted for backward
compatibility and has no write-time effect. This contract adds no column or
migration.

`ProjectStoreApi.getEventStreamDemand()` is an on-demand aggregate over existing
project bindings, tasks, push targets, and per-repository changes; it adds no
schema or migration. Enabled review projects request their `code_review`
integration immediately. Coding push targets request a stream only while a
non-terminal task has a persisted, non-`NO_CHANGE`, non-`ORPHANED` external
change, and non-terminal review
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

## Per-Repository Change Status

- Integration-scoped `findTaskByExternalChangeId()` lookup for `change_per_repository` rows excludes `NO_CHANGE` / `ORPHANED` / `MERGED` / `ABANDONED` entries and returns no task when more than one task matches, rather than selecting the most recently updated task.
- When no per-repository row resolves, legacy code-generation `tasks.gerrit_change_id` values resolve only if the task's project has exactly one push target for the supplied integration. Projectless tasks, multiple targets, and multiple task candidates remain unresolved.
- `updateChangePerRepositoryStatusById(taskId, changeRowId, status)` updates a single existing row using `(task_id, id)`. It does not reactivate `NO_CHANGE` / `ORPHANED` rows or downgrade a persisted `MERGED` / `ABANDONED` status from a stale poll. This store-contract change adds no column, index, or migration.

## Project Vendor Components

- `project_vendor_components` (INTEGER `id` PK) persists workspace-scanned third-party components of a coding project: `project_id` (FK → `projects.id`), `source_path` (NOT NULL, the real manifest path in the checkout), nullable `local_path` / `clone_url` / `revision`, `origin`, and timestamps. The table holds only components no repository of ours owns; one that we do own becomes a `project_push_targets` row instead. `replaceProjectVendorComponents()` deletes and reinserts the project's rows in one transaction but carries the previous `created_at` over for any `(source_path, local_path)` pair that survives the replace, so the column keeps meaning "first tracked".
- `origin` is one of `internal | fork_pushable | patch_required | ambiguous` (see `VendorComponentOrigin` in `src/interfaces.ts`) and records whether VE can push to the component or must patch it locally.
- `uq_pvc_project_source_local` is the identity over `(project_id, source_path, NULL-normalized local_path)`. The SQLite expression uses `CASE WHEN local_path IS NULL THEN '' ELSE local_path END`, which is equivalent to `COALESCE(local_path, '')` but remains compatible with the pinned drizzle-kit generator. One manifest routinely declares several components — every kas layer of a Yocto workspace is declared by the same `.config.yaml` — so the declaring path alone would collapse them into a single row.
- `replaceProjectVendorComponents` deletes and re-inserts in one transaction, so a rejected batch leaves the previous set intact; `listProjectVendorComponents` orders by `source_path`. `deleteProject` removes the project's rows.

## Migration Path

- `src/state/schema.ts` is the declarative schema source. `npm run db:generate` writes immutable SQL plus metadata under the version-controlled `drizzle/` directory; every schema, index, or constraint change must commit a newly generated migration. Never edit an already-applied migration.
- Migration `0005_careful_vision.sql` adds nullable `provider_comment_url` and non-null `disposition` (`unknown` for legacy rows, `inline` or `folded` for new hosted findings) to `posted_review_comments`. It replaces the former permanent `(task_id, comment_hash)` unique index with a partial unique index for `resolved = 0`: only active findings are deduplicated. Explicitly fixed findings retain their history but may be reported again if the issue returns. A folded finding has no inline URL; a successfully posted inline finding stores its provider discussion URL and thread ID. Pending remote publication IDs live in the review agent-cycle metadata, not this table.
- The backup schedule migration adds the four nullable backup schedule columns to `app_settings`; the backup archive directory and one-shot restore source/force controls are environment settings, not database columns.
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
