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

## Deep review

Deep review is an opt-in mode for review agents that use the VE direct strategy. Instead of one agent run, each pass runs six: an intent stage that checks what the change is meant to do against what the diff does; four specialist stages (control flow and data; state, lifetime, and concurrency; contracts and integration; conventions, tests, and documentation), each told what the intent stage raised; and a final stage that merges duplicate findings, orders them by how much the author must act on them, and writes the posted review. The usual comment cap, severity floor, and dedupe still apply to the result.

It suits repositories where a missed problem costs more than a longer review, such as core daemons, security-sensitive code, or large changes. Expect about 4 to 5 times the cost of a standard review, about twice as many comments, and several minutes per review instead of about one.

Deep review uses its own stage instructions and ignores the agent's Workflow Instructions prompt; the system prompt, model, and skills still apply.

To enable it, edit a review agent, keep the **VE direct** strategy, and set **Review depth** to **Deep**. Projects cannot override the depth: bind the projects that need it to a separate deep review agent. Each stage holds one of the agent integration's concurrency slots, so with `maxConcurrent` of 1 the specialists run one after another; raise that agent's `maxConcurrent` to 4 or more to run them in parallel. Set the depth back to **Standard** to turn it off.
