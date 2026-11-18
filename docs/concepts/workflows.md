# The two workflows

code-gen and code-review, side by side.

code-gen

## Coding

An assigned ticket becomes a task. The agent edits the workspace in the sandbox; the host pushes the resulting commits for review and feeds review comments into the next cycle.

code-review

## Review

A new patchset, merge request, or pull request becomes a task. The agent runs with `REVIEW_MODE=1` against the diff and posts inline findings, replies, and a decision.

## Review routing is integration-scoped

A review task persists `ticketSourceLabel = <type>:<integrationId>`, so several active review integrations cannot collide on the same change number.

Review runs download nothing back from the sandbox, so any file the reviewing agent edits is discarded by construction.
