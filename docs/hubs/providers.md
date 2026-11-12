# Providers

The four external systems and their quirks.

Four external systems, bound by capability rather than by name.

| Name | Capabilities | Description |
| --- | --- | --- |
| Redmine | issue_tracking | Ticket source for coding tasks. API key against your instance; issues assigned to the agent are picked up on the polling tick. |
| GitLab | issues · code · review | Personal access token or OAuth device flow, on gitlab.com or self-hosted. Merge requests carry the change and receive inline comments, replies, and approval. |
| GitHub | issues · code · review | Personal access token or OAuth, with HMAC-signed webhooks. Reviewers must be usernames, not emails. |
| Gerrit | code · review | SSH stream-events connection kept open per active integration. Changes get inline comments plus a code-review vote per patchset. |

Reviewer handling differs by provider — see [Push targets and reviewers](../guides/push-targets.md).
