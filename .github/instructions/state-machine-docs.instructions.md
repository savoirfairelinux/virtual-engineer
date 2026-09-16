---
applyTo: "src/state/stateMachine.ts,src/interfaces.ts,src/domain/tasks.ts"
description: "Keep state-machine documentation in sync with VALID_TRANSITIONS and TASK_STATES."
---
# Keep `.github/context/state-machine.md` in sync

When editing any file matched by `applyTo`:

1. If `TASK_STATES`, `TERMINAL_STATES`, or their domain definitions in `src/domain/tasks.ts` changed, update the **States** table in [.github/context/state-machine.md](../context/state-machine.md), which is the canonical state reference.
2. If `VALID_TRANSITIONS` in `src/state/stateMachine.ts` changed, update the **Valid Transitions** block in `state-machine.md`. It must match the source map exactly.
3. If a transition gained or lost a side effect, update the **Side effects per transition** table.
4. Pause/resume must remain documented as `state_transitions` rows where `from_state == to_state` with `metadata.action`. Do **not** introduce boolean columns without updating the doc accordingly.
