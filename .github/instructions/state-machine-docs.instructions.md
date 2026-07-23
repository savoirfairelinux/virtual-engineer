---
applyTo: "src/state/stateMachine.ts,src/interfaces.ts"
description: "Keep state-machine documentation in sync with VALID_TRANSITIONS and TASK_STATES."
---
# Keep `.github/context/state-machine.md` in sync

When editing any file matched by `applyTo`:

1. If `TASK_STATES` or `TERMINAL_STATES` in `src/interfaces.ts` changed, update the **States** table in [.github/context/state-machine.md](../context/state-machine.md) **and** the lifecycle one-liner in [.github/copilot-instructions.md](../copilot-instructions.md).
2. If `VALID_TRANSITIONS` in `src/state/stateMachine.ts` changed, update the **Valid Transitions** block in `state-machine.md` **and** the **Full transition map** in `copilot-instructions.md`. They must match the source map exactly.
3. If a transition gained or lost a side effect, update the **Side effects per transition** table.
4. Pause/resume must remain documented as `state_transitions` rows where `from_state == to_state` with `metadata.action`. Do **not** introduce boolean columns without updating the doc accordingly.
