# Database Context

## Agent Prompt References

- `agents.system_prompt_id` and `agents.instructions_prompt_id` are nullable foreign keys at the SQLite schema level, but the store and admin API require both for every create/update.
- `prompts.prompt_type` is the prompt's runtime role: `system | instructions`, with `instructions` as the database default. The user prompt is generated per cycle from the ticket or review and is not a stored prompt type.
- New agents cannot be created through the admin API without both references. Each ID must resolve to an existing `prompts` row with the matching role, and updates cannot clear either reference.
- Runtime resolution is fail-closed: agents missing either prompt, referencing a missing prompt, or crossing the `system` / `instructions` roles do not receive a generic or integration-specific fallback.
- Fresh databases seed exactly five built-ins: `system_generic_code`, `instructions_generic_code`, `instructions_feedback_code`, `system_review`, and `instructions_review`. Provider-specific aliases and alias override files are not seeded or migrated.
- Startup preserves unknown prompt rows, normalizes unsupported stored roles to `instructions`, and derives referenced roles from existing agent and project-override references. A prompt referenced in both roles is cloned for the instructions side and those references are repointed without changing content; prompt hydration also defensively maps any unsupported role to `instructions`, and obsolete `user_*_review.md` files are ignored.

## Projects Skill Columns

- `projects.skill_sources_json` is a non-null text JSON column with default `[]`. It stores optional project-configured external skill sources installed into the agent home volume before the agent container starts. The empty value is the database/API default; the admin UI's new-project form preloads the SFL `agent-skills` SSH source with `installAll: true`, so saving that untouched form persists a non-empty value.
- Repository skill discovery is provider-owned and is not project configuration. The former `projects.skill_discovery_enabled` and `projects.local_skills_path` columns are removed, and the admin API rejects both deleted request fields.

## Project Push Targets

- `project_push_targets.reviewer_emails` is a non-null text column containing a JSON string array, defaulting to `[]`. Gerrit receives one `r=<email>` push option per address, while GitLab resolves visible `email` or `public_email` values to numeric `reviewer_ids` and updates an existing MR when necessary.
- The admin API trims and lowercases addresses, removes case-insensitive duplicates, and accepts at most 20 per target. Reviewer emails are supported only for Gerrit and GitLab push targets; GitHub requires usernames and rejects non-empty reviewer-email configuration.
- `addProjectPushTarget` and `replaceProjectPushTargets` JSON-encode reviewer emails on write. `listProjectPushTargets` returns parsed string arrays and safely falls back to `[]` for malformed legacy values.

## Project Vendor Components

- `project_vendor_components` (INTEGER `id` PK) persists workspace-scanned third-party components of a coding project: `project_id` (FK → `projects.id`), `source_path` (NOT NULL, the real manifest path in the checkout), nullable `local_path` / `clone_url` / `revision`, `origin`, and timestamps. The table holds only components no repository of ours owns; one that we do own becomes a `project_push_targets` row instead. `replaceProjectVendorComponents()` deletes and reinserts the project's rows in one transaction but carries the previous `created_at` over for any `(source_path, local_path)` pair that survives the replace, so the column keeps meaning "first tracked".
- `origin` is one of `internal | fork_pushable | patch_required | ambiguous` (see `VendorComponentOrigin` in `src/interfaces.ts`) and records whether VE can push to the component or must patch it locally.
- `UNIQUE(project_id, source_path, COALESCE(local_path, ''))` (`uq_pvc_project_source_local`) is the identity. One manifest routinely declares several components — every kas layer of a Yocto workspace is declared by the same `.config.yaml` — so the declaring path alone would collapse them into a single row.
- `replaceProjectVendorComponents` deletes and re-inserts in one transaction, so a rejected batch leaves the previous set intact; `listProjectVendorComponents` orders by `source_path`. `deleteProject` removes the project's rows.

## Migration Path

- Runtime migrations are handled by `SqliteStateStore.applyMigrations()` in `src/state/stateStore.ts` using `CREATE TABLE IF NOT EXISTS` and `ensureColumn(...)`.
- Existing databases get `project_vendor_components` through `CREATE TABLE IF NOT EXISTS`; the table starts empty and is populated only when an operator saves scanned components.
- Existing databases drop `skill_discovery_enabled` and `local_skills_path` through `dropColumnIfExists(...)`; project rows and the remaining columns are preserved.
- Existing databases get `reviewer_emails` through `ensureColumn("project_push_targets", "reviewer_emails", "TEXT NOT NULL DEFAULT '[]'")`.
- Existing databases get nullable `app_settings.agent_timeout_ms` through `ensureColumn(...)`; NULL falls back to the `AGENT_TIMEOUT_MS` config default.
- Existing databases get nullable `app_settings.ticket_close_max_retries` and `app_settings.ticket_close_retry_min_timeout_ms` through `ensureColumn(...)`; NULL falls back to the `TICKET_CLOSE_MAX_RETRIES` / `TICKET_CLOSE_RETRY_MIN_TIMEOUT_MS` config defaults.
- Existing databases get `prompt_type` through `ensureColumn("prompts", "prompt_type", "TEXT NOT NULL DEFAULT 'instructions'")`; null, `user`, and other unsupported values are normalized to `instructions`, the five canonical built-ins are assigned their declared roles, then custom roles are derived from agent and project override references. Dual-role rows are cloned for instructions references. Missing built-in rows recreated through `upsertPrompt()` use their declared role. Old provider-specific rows are treated as ordinary data and are not translated; deployments adopting the canonical-only model must reset or edit those references explicitly.
- `backfillLegacyCycleCosts()` runs on every `applyMigrations()` call (i.e. every process start) and recomputes/persists the `agent_cycles` cost columns for rows where all 8 are still NULL (legacy rows saved before those columns existed). It parses `agent_events` first, falls back to `agent_result`'s embedded `agentEvents`, and writes via `computeCycleCost()`/`hasCostData()` using the same null-if-zero mapping as `saveAgentCycle()`. Rows with no recoverable event log are left fully NULL. It is idempotent — once a row has any non-NULL cost column it is no longer selected. This is the **only** place cost is ever recomputed from event JSON: `getCostSummary()`/`getModelUsageSummary()` (`src/state/stores/costStore.ts`) and `getAgentCycles()` (`src/state/stores/taskStore.ts`) read the snapshot columns directly with no read-time fallback.
- `src/state/schema.ts` mirrors these columns for Drizzle typed queries.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [state-machine.md](state-machine.md) — `state_transitions` rows and pause/resume
- [configuration.md](configuration.md) — `app_settings` (DB-managed workflow settings)
- [copilot-instructions.md](../copilot-instructions.md) — Critical Schema Facts (always-loaded, authoritative)
- [ve-debug skill](../skills/ve-debug/SKILL.md) — SQLite query recipes for debugging
