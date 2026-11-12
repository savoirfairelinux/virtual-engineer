# Review

Ingestion, bounds, and routing guarantees.

Everything about the review workflow, in one place.

## Ingestion

```
webhook / Gerrit stream-event / review-assignment poll
  → buildReviewTrigger()
  → ReviewOrchestrator.startReviewTask()
  → sandbox run with REVIEW_MODE=1
  → provider posts comments and vote
  → REVIEW_WATCHING / REVIEW_DONE / REVIEW_FAILED
```

## Bounds

| Name | Default | Description |
| --- | --- | --- |
| `MAX_REVIEW_DIFF_CHARS` | 60 000 | Maximum diff characters injected into the review prompt. |
| `MAX_REVIEW_COMMENTS` | 20 | Inline comments per pass; the rest fold into the summary. |
| `MAX_REVIEW_REPLIES` | 20 | Discussion-thread replies posted per pass. |
| `REVIEW_MIN_SEVERITY` | info | Floor for an inline comment: nit < info < warning < error. |

## Guarantees

- Routing is integration-scoped end to end, so two review integrations cannot collide on one change number.
- Review runs download nothing, so review-time edits are discarded.
- A follow-up patchset re-enters `REVIEW_RUNNING` from `REVIEW_WATCHING` instead of creating a second task.

See also [First review project](../start/first-review.md), [Tune review output](../guides/tune-review.md), [prompts](../concepts/prompts.md).
