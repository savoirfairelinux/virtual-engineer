# Migrations

Immutable history, fail-closed runner.

Schema changes go through `src/state/schema.ts` and `npm run db:generate`, which writes an immutable migration under `drizzle/`.

Applied migrations are never edited. The runner validates recorded SQL hashes against the checked-in history and fails closed on unknown or modified history, so a rewritten migration is a startup error rather than a silent divergence.

## Adding a state

A new `TaskState` needs its enum entry, its edges in the transition map, and a migration. An edge that is not declared throws at runtime.
