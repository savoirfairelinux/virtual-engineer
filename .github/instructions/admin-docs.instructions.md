---
applyTo: "src/admin/**"
description: "Keep admin server documentation in sync with routes and behavior."
---
# Keep `.github/context/modules/admin.md` in sync

When editing files under `src/admin/`:

1. New / removed / renamed HTTP route → update the **Endpoints** table in [.github/context/modules/admin.md](../context/modules/admin.md).
2. Change to secret masking, `PUT` restore semantics, or auth (cookie / bearer) → update the matching section.
3. Dashboard tab additions or visualization changes (e.g. live agent log) → update the **Dashboard** section.
4. New admin action exposed for tasks (pause/resume/abandon/retry/etc.) → keep the table aligned and cross-check `modules/orchestrator.md` for the underlying API.
