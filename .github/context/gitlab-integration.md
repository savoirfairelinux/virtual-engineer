# GitLab Integration — Reference

GitLab is a **first-class, implemented** provider in Virtual Engineer (both for ticketing — GitLab Issues — and review — GitLab Merge Requests). This document is a reference to the live implementation, not a roadmap.

## What ships today

| Concern | Implementation |
|---|---|
| Issue connector | [src/connectors/gitlabIssueConnector.ts](../../src/connectors/gitlabIssueConnector.ts) |
| MR connector | [src/connectors/gitlabMergeRequestConnector.ts](../../src/connectors/gitlabMergeRequestConnector.ts) |
| HTTP client | [src/connectors/gitlabHttpClient.ts](../../src/connectors/gitlabHttpClient.ts) |
| Push / MR create | [src/vcs/gitlabVcsConnector.ts](../../src/vcs/gitlabVcsConnector.ts) |
| Plugin descriptor | [src/plugins/descriptors/gitlab.ts](../../src/plugins/descriptors/gitlab.ts) (the former `gitlab-issue.ts` + `gitlab-merge-request.ts` split descriptors were merged into this single unified provider descriptor) |
| Tests | `gitlabIssueConnector.test.ts`, `gitlabIssueDiscovery.test.ts`, `gitlabMergeRequestConnector.test.ts`, `gitlabMergeRequestDiscovery.test.ts`, `gitlabVcsConnector.test.ts`, `gitlabHttpClient.test.ts` |

## Configuration

All GitLab configuration lives in the database via `integrations` rows, managed through the admin UI. There are no GitLab-specific env vars.

A GitLab integration is a single `integrations` row with `provider: "gitlab"` (the former `type` column was removed, and the `category` concept no longer exists). The unified descriptor in `src/plugins/descriptors/gitlab.ts` exposes all domain capabilities — `issue_tracking`, `code_review`, and `source_control` — from that one row; there is no per-role integration split.

The descriptor's Zod schema validates `config_json` (base URL, `authMode = oauth | pat`, token, webhook secret, Git author defaults). Multiple GitLab integrations (e.g. different instances) can be active simultaneously.

GitLab **project selection is VE-project-owned**, not integration-owned:
- the issue project comes from the project's `issue_tracking` binding in `project_integration_bindings` (`config_json.ticketProjectKey`);
- push / MR target projects come from `project_push_targets.repo_key`;
- review repositories come from the `code_review` binding (`config_json.repos`).

Legacy integration-level fields (`projectId`, label overrides) are compatibility fallbacks only.

### Mixed mode

Capabilities resolve independently per project binding. A GitLab Issues + Gerrit review setup is supported (and vice versa).

## Operational notes

- Auth: PAT in the `PRIVATE-TOKEN` header for REST; HTTPS with `oauth2:<token>@…` for git push.
- MR resolution maps to `existingChangeId` in `AgentSession`: when set, the connector pushes to the same source branch and updates the existing MR rather than creating a new one.
- Comment IDs from MR discussions populate `processed_comments` for dedup, exactly like Gerrit comment IDs.
- The state machine is provider-agnostic — no GitLab-specific states.
- Webhook delivery: GitLab issues and MRs use per-integration webhook secrets stored in `configJson.webhookSecret` (rotated via the admin API).
- Workflow label names (`inProgressLabel`, `inReviewLabel`) are configured per integration — there are no built-in defaults.

## Where to look first

- Add a GitLab-specific feature → start in the matching connector + the unified `gitlab` descriptor + its tests.
- Debug auth → `src/connectors/gitlabHttpClient.ts` (header construction) + `src/vcs/gitlabVcsConnector.ts` (git URL).
- Debug MR creation → `tests/unit/gitlabMergeRequestConnector.test.ts` + `gitlabVcsConnector.test.ts`.

## Related docs

- [INDEX.md](INDEX.md) — navigable context index
- [modules/connectors.md](modules/connectors.md) — GitLab issue / MR connectors
- [modules/vcs.md](modules/vcs.md) — GitLab VCS push layer
- [modules/plugins.md](modules/plugins.md) — unified `gitlab` descriptor
