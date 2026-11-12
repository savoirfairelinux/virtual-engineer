# First review project

Review incoming patchsets with no issue tracker.

A review project needs no issue tracker. It needs a code-review integration, a source-control binding, and an agent.

- Bind a `code_review` integration and scope it to the repositories it should watch.
- Bind an agent whose prompts are `system_review` and `instructions_review`.
- Enable the project, then push a patchset or open a merge request.

Gerrit arrives over an SSH stream-events connection; GitLab and GitHub arrive over webhooks. The task walks `REVIEW_PENDING → REVIEW_RUNNING → REVIEW_COMMENTING`, then waits in `REVIEW_WATCHING` for a follow-up patchset.

Bounds and severity floors are in the [review hub](../hubs/review.md).
