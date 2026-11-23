# Tune review output

Bound comments and raise the severity floor.

Review output is bounded so one pass cannot flood a change. Findings below the severity floor are folded into the summary comment instead of being posted inline.

| Name | Default | Description |
| --- | --- | --- |
| `MAX_REVIEW_DIFF_CHARS` | 60 000 | Maximum diff characters injected into the review prompt. |
| `MAX_REVIEW_COMMENTS` | 20 | Inline comments per pass; the rest fold into the summary. |
| `MAX_REVIEW_REPLIES` | 20 | Discussion-thread replies posted per pass. |
| `REVIEW_MIN_SEVERITY` | info | Floor for an inline comment: nit < info < warning < error. |

Raise the floor before raising the comment cap: a quieter review is usually a more useful one.

The built-in review instructions tell the agent to read the repository's own contribution and style guidance and to report where a change departs from it or from the surrounding code. These convention findings carry severity `info`, or `nit` when cosmetic. Setting `REVIEW_MIN_SEVERITY` to `warning` folds them into the summary, along with any defect the agent rated below `warning`.

Review agents cannot run Git, so VE clones the last 50 commits of the target branch and adds their messages, and the recent commits touching each changed file, to the review prompt. The agent uses them to follow the repository's commit-message conventions and the way earlier changes were made.
