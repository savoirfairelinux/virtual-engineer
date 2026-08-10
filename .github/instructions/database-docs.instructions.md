---
applyTo: "src/state/schema.ts,src/state/databaseMigrations.ts,src/state/stateStore.ts,src/state/migrate.ts"
description: "Keep database documentation in sync with the schema."
---
# Keep `.github/context/database.md` in sync

When editing any file matched by `applyTo`:

1. Open [.github/context/database.md](../context/database.md) and verify every column / table / default still matches `src/state/schema.ts`. The authoritative schema facts also live in the **Critical Schema Facts** section of [.github/copilot-instructions.md](../copilot-instructions.md) — keep both in sync.
2. If a table, column, default, or constraint changed, update the corresponding section in `database.md` **and** the matching bullet in the **Critical Schema Facts** section of `copilot-instructions.md`.
3. If a `stateStore` or `src/state/stores/*` method was added, removed, or its signature changed, mention it in `database.md` under the relevant table's notes.
4. If timestamp encoding changed, update the seconds-vs-milliseconds note (currently: seconds since epoch — `datetime(col, 'unixepoch')`).
5. For every table, column, index, or constraint change, run `npm run db:generate` and commit the new SQL plus `drizzle/meta/` updates. Never edit a migration that may already have been applied.
6. Keep the pre-ledger compatibility bridge in `src/state/databaseMigrations.ts` frozen. Future schema changes belong only in `schema.ts` and newly generated migrations.
