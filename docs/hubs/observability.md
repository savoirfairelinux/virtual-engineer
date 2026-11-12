# Observability

Transitions, cost, and live logs.

Three sources answer almost every question about a run: the transition log, the cycle record, and the live agent stream.

## Transitions

Every state change writes a `state_transitions` row with metadata. Timestamps are stored in seconds, so read them with `datetime(col, 'unixepoch')`.

## Cost and model usage

Derived from `assistant.usage` events and snapshotted onto `agent_cycles` at write time. Summaries read those columns directly.

## Live logs

The Admin UI streams agent logs over the shared agent event bus while a cycle runs. Sandbox policy denials are harvested after each attempt, scrubbed, and deduplicated.

Query recipes are in [Debug a task](../operations/debug.md).
