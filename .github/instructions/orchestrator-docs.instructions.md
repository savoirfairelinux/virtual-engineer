---
applyTo: "src/orchestrator/**"
description: "Keep orchestrator documentation in sync."
---
# Keep `.github/context/modules/orchestrator.md` in sync

When editing files under `src/orchestrator/`:

1. New / removed / renamed public method on `Orchestrator` → update the **`Orchestrator`** section in [.github/context/modules/orchestrator.md](../context/modules/orchestrator.md).
2. Change to polling intervals or pause/resume gating → update `pollingLoop.ts` section.
3. Change to `feedbackProcessor` dedup logic → update its section and cross-check `state-machine.md` (`FEEDBACK_PROCESSING` side effect).
4. New runtime dependency (config field, plugin category, etc.) → update the **Configuration** section.
