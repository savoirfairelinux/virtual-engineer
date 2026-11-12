# Debug a task

Read the transition log and what it implies.

Start from the transition log. It is append-only, so it tells you what happened rather than what the current state implies.

```
SELECT from_state, to_state, metadata,
       datetime(created_at, 'unixepoch') AS at
FROM state_transitions
WHERE task_id = 'X'
ORDER BY id;
```

## Reading it

- A row where `from_state == to_state` is a pause or resume, not a loop.
- Repeated `RETRY_CYCLE` rows mean review feedback kept coming back; check `MAX_AGENT_CYCLES`.
- A task that never left `CONTEXT_BUILDING` is a host-side clone or binding problem, not an agent problem.
- A cycle that ends in `FAILED` right after `AGENT_RUNNING` is usually a sandbox policy denial — check the harvested denials for that sandbox.
