---
applyTo: "tests/**"
description: "Keep testing.md inventory in sync."
---
# Keep `.github/context/testing.md` in sync

When adding, removing, or significantly reorganising tests:

1. New top-level test category (e.g. a new module domain) → add it to the **Test families by area** table in [.github/context/testing.md](../context/testing.md).
2. New testing convention (helper, fixture, mock pattern) used across multiple files → mention it in the **Conventions** section.
3. The pre-commit gate (`npm test`, `npm run typecheck`, `npm run lint`) is mandatory; do not weaken or document a weaker workflow.
