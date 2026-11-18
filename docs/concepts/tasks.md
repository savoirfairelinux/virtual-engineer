# Tasks and cycles

The unit of work, and how many times it may run.

A task is the unit of work and the unit of audit. It carries a `taskType` of `code-gen` or `code-review`, and every change to it is an appended row rather than an overwritten field.

## Cycles

A cycle is one agent execution. A coding task may run several: the first implements the ticket, later ones fold in review feedback. `MAX_AGENT_CYCLES` caps them per task, `MAX_RETRY_ATTEMPTS` caps how often polling re-picks a failing ticket, and `MAX_COMMITS_PER_CYCLE` caps commits inside one cycle.

## Cost

Per-cycle cost is derived from `assistant.usage` events and snapshotted onto `agent_cycles` at write time, so summaries never recompute at read time.
