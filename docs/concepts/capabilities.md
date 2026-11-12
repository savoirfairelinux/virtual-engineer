# Capabilities and bindings

Why the workflow never names a provider.

Providers are never named in the workflow. A project holds one row per capability in `project_integration_bindings`, so tickets can come from Redmine while code goes to GitLab.

| Name | Default | Description |
| --- | --- | --- |
|  | issue_tracking | Where tickets are assigned from, scoped by a ticket project key — Redmine, GitLab Issues, or GitHub Issues. |
|  | source_control | Where the repository lives and where the host pushes the resulting commits. |
|  | code_review | Where the change is opened and where review events come back, scoped to a set of repositories. |
|  | agent_execution | Which engine runs the cycle. A review-only project needs no issue tracker. |

Delivery targets live in the separate `project_push_targets` table, ordered by `commitOrder`. See [Push targets and reviewers](../guides/push-targets.md).
