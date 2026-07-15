# Database Context

## Projects Skill Columns

- `projects.skill_discovery_enabled` is an integer trust gate. When enabled, the agent container receives `SKILL_DISCOVERY=1` and loads project-approved skills.
- `projects.local_skills_path` is a non-null text column with default `.github/skills`. It stores the workspace-relative directory used for local project skills. The admin API rejects absolute paths and `..` segments; the worker also falls back to `.github/skills` if an invalid path reaches the container.
- `projects.skill_sources_json` is a non-null text JSON column with default `[]`. It stores project-configured external skill sources installed into the agent home volume before the agent container starts.

## Migration Path

- Runtime migrations are handled by `SqliteStateStore.applyMigrations()` in `src/state/stateStore.ts` using `CREATE TABLE IF NOT EXISTS` and `ensureColumn(...)`.
- Existing databases get `local_skills_path` through `ensureColumn("projects", "local_skills_path", "TEXT NOT NULL DEFAULT '.github/skills'")`.
- `src/state/schema.ts` mirrors these columns for Drizzle typed queries.
