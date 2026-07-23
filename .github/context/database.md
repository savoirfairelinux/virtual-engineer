# Database Context

## Agent Prompt References

- `agents.system_prompt_id` and `agents.instructions_prompt_id` remain nullable foreign keys for compatibility with databases containing legacy agents.
- New agents cannot be created through the admin API without both references, and both IDs must resolve to existing `prompts` rows. Updates cannot clear either reference.
- Runtime resolution is fail-closed: legacy agents missing either prompt, or agents referencing a prompt that no longer resolves, do not receive a generic or integration-specific fallback.

## Projects Skill Columns

- `projects.skill_discovery_enabled` is an integer trust gate for local repository skills only. When enabled, the agent container receives `SKILL_DISCOVERY=1` and loads local skills from `local_skills_path`.
- `projects.local_skills_path` is a non-null text column with default `.github/skills`. It stores the workspace-relative directory used for local project skills. The admin API rejects absolute paths, `.`, and `..` segments; the worker also falls back to `.github/skills` if an invalid path reaches the container.
- `projects.skill_sources_json` is a non-null text JSON column with default `[]`. It stores project-configured external skill sources installed into the agent home volume before the agent container starts whenever configured, independent of `skill_discovery_enabled`. The empty value is the database/API default; the admin UI's new-project form preloads the SFL `agent-skills` SSH source with `installAll: true`, so saving that untouched form persists a non-empty value.

## Project Push Targets

- `project_push_targets.reviewer_emails` is a non-null text column containing a JSON string array, defaulting to `[]`. Gerrit receives one `r=<email>` push option per address, while GitLab resolves visible `email` or `public_email` values to numeric `reviewer_ids` and updates an existing MR when necessary.
- The admin API trims and lowercases addresses, removes case-insensitive duplicates, and accepts at most 20 per target. Reviewer emails are supported only for Gerrit and GitLab push targets; GitHub requires usernames and rejects non-empty reviewer-email configuration.
- `addProjectPushTarget` and `replaceProjectPushTargets` JSON-encode reviewer emails on write. `listProjectPushTargets` returns parsed string arrays and safely falls back to `[]` for malformed legacy values.

## Migration Path

- Runtime migrations are handled by `SqliteStateStore.applyMigrations()` in `src/state/stateStore.ts` using `CREATE TABLE IF NOT EXISTS` and `ensureColumn(...)`.
- Existing databases get `local_skills_path` through `ensureColumn("projects", "local_skills_path", "TEXT NOT NULL DEFAULT '.github/skills'")`.
- Existing databases get `reviewer_emails` through `ensureColumn("project_push_targets", "reviewer_emails", "TEXT NOT NULL DEFAULT '[]'")`.
- `src/state/schema.ts` mirrors these columns for Drizzle typed queries.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [state-machine.md](state-machine.md) — `state_transitions` rows and pause/resume
- [configuration.md](configuration.md) — `app_settings` (DB-managed workflow settings)
- [copilot-instructions.md](../copilot-instructions.md) — Critical Schema Facts (always-loaded, authoritative)
- [ve-debug skill](../skills/ve-debug/SKILL.md) — SQLite query recipes for debugging
