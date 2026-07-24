# Modules — Connectors

**Source:** [src/connectors/](../../../src/connectors/).

Connectors are HTTP/SSH clients for external systems. They are resolved at runtime by the **plugin manager** (see [plugins.md](plugins.md)) — the orchestrator never imports a concrete connector directly.

## Shared base

### `AbstractTicketConnector` — [src/connectors/baseTicketConnector.ts](../../../src/connectors/baseTicketConnector.ts)

Provides default `transitionToInProgress` / `transitionToInReview` implementations so concrete ticket connectors delegate via `transitionStatus(ticketId, statusId)`.

### `GerritSshClient` — [src/connectors/gerritSshClient.ts](../../../src/connectors/gerritSshClient.ts)

Shared SSH transport and Gerrit protocol helper. Encapsulates `ssh gerrit …` execution, NDJSON parsing, and `buildSshHostKeyOptions()` so that `GerritConnector`, `GerritSshReviewProvider`, `GerritVcsConnector`, and `GerritStreamEventsManager` share a single SSH client rather than duplicating implementation. Top-level Jenkins lifecycle notices and vote-only messages are filtered; failed/aborted/unstable builds are retained with `ci-failure-*` IDs for the orchestrator's project-level gate. When resolving inline feedback, the client best-effort reads Gerrit's anonymous comments endpoint and sends `in_reply_to` through `gerrit review --json`, falling back to a fresh resolved comment when no UUID is available.

### `GitLabHttpClient` — [src/connectors/gitlabHttpClient.ts](../../../src/connectors/gitlabHttpClient.ts)

Shared HTTP helper with `Authorization: Bearer` injection, error translation, and paginated fetching. Used by both `GitLabIssueConnector` and `GitLabMergeRequestConnector`, so the same runtime path works for both GitLab PATs and GitLab OAuth access tokens.

## Capabilities

Connectors are unchanged in shape, but they are now produced by **capability factories** on the unified provider descriptors (see [plugins.md](plugins.md)) rather than per-type `createInstance` hooks. A single provider descriptor can expose several domain capabilities.

| Domain capability | Implementations | Factory |
| --- | --- | --- |
| `issue_tracking` | `redmineConnector`, `gitlabIssueConnector`, `githubIssueConnector` | `capabilities.issue_tracking.createConnector` |
| `code_review` | `gerritConnector`, `gerritSshReviewProvider`, `integrationStreamEvents`, `gerritStreamEvents`, `gitlabMergeRequestConnector`, `gitlabMergeRequestReviewProvider`, `githubPullRequestReviewConnector`, `githubReviewProvider` | `capabilities.code_review.{ createConnector, createReviewer, streamEvents }` |

The `provider` ids are `github | gitlab | gerrit | redmine | copilot | claude | aider | mock`. Repository push/commit lives in [src/vcs/](../../../src/vcs/) via `capabilities.source_control.createVcsConnector` — see [vcs.md](vcs.md). The `copilot`, `claude`, `aider`, and `mock` providers expose only `agent_execution` and have no connectors here.

Reviewer-side `ReviewProvider` reads and effects accept an optional `AbortSignal`. GitHub and GitLab forward it to `fetch`; Gerrit forwards it to SSH and temporary Git subprocesses. Multi-request best-effort fallbacks rethrow cancellation instead of folding or suppressing it, so the orchestrator's single review deadline can terminate freshness checks, comments, replies, and votes.

Reviewer decisions are normalized internally as `-1 | 0 | 1`, then translated by each provider. Gerrit always submits the corresponding `Code-Review` label, including `0` to clear a prior vote; GitHub maps them to `REQUEST_CHANGES` / `COMMENT` / `APPROVE`; GitLab maps them to unapprove / no approval action / approve. The agent-facing JSON contract uses provider-native field names (`vote`, `reviewAction`, or `approvalAction`) and is selected from `reviewProvider.kind`.

## Ticketing contract (`TicketConnector`)

Methods used by the orchestrator:

- `getAssignedTickets()` — list tickets assigned to the VE user.
- `getTicket(ticketId)` — full ticket + custom fields.
- `transitionStatus(ticketId, status)` — move to in-progress, in-review, closed.
- `addNote(ticketId, body)` — post a comment (uses `ticketFooterFormatter` for traceability footer).
- `closeTicket(ticketId)`.
- HTTP failures should throw `TicketApiError` from `src/interfaces.ts`; missing tickets/resources should throw `TicketNotFoundError` so the orchestrator can stay provider-agnostic.

### `RedmineConnector` — [src/connectors/redmineConnector.ts](../../../src/connectors/redmineConnector.ts)

- REST API key auth (`X-Redmine-API-Key` header).
- Status IDs are configurable per integration via `configJson`: `inProgressStatusId` (default `2`), `inReviewStatusId` (`4`), `closedStatusId` (`5`).
- Polls `/issues.json?assigned_to_id=<VE user>`.

### `GitlabIssueConnector` — [src/connectors/gitlabIssueConnector.ts](../../../src/connectors/gitlabIssueConnector.ts)

- Token auth through `Authorization: Bearer`, which allows both GitLab PATs and GitLab OAuth access tokens.
- Maps the same orchestrator-facing contract onto GitLab issue endpoints.
- Reuses the same `in-progress / in-review / closed` workflow semantics.
- The GitLab project selector can come from the VE project ticket binding (`ticketProjectKey`) rather than from the integration row.
- Workflow label names default to `in-progress` / `in-review`; legacy integration rows may still override them with `inProgressLabel` / `inReviewLabel`.

## Review contract (`ReviewConnector`)

Methods used by the orchestrator:

- `getChange(changeRef)` — resolve change/MR + current patchset.
- `getChangeStatus(changeRef)` → `"OPEN" | "MERGED" | "ABANDONED"`.
- `getUnresolvedComments(changeRef)` — comments with stable IDs for dedup.
- `addChangeComment(changeRef, body)`.
- `resolveComments(changeRef, commentIds)`.

### `GerritConnector` — [src/connectors/gerritConnector.ts](../../../src/connectors/gerritConnector.ts)

- SSH-only connector for review feedback and repository discovery.
- Delegates SSH transport to `GerritSshClient`.
- Uses `ssh gerrit query`, `ssh gerrit review`, and `ssh gerrit ls-projects` with `sshHost`, `sshPort`, `sshUser`, and `sshKeyPath`.
- `baseUrl` is optional and used only to build clickable Gerrit web links; review operations no longer depend on REST credentials.
- `listRepositoriesViaSsh()` is the shared SSH discovery helper used by integration testing, admin discovery, and runtime connection checks.
- `listBranchesViaSsh(ssh, repoKey)` runs `git ls-remote --heads ssh://…/<repoKey>` (with `GIT_SSH_COMMAND` carrying the key + host-key options) and parses `refs/heads/*` into branch names; surfaced via `GerritSshConnector.listBranches()` and the descriptor `discoverBranches` hook.
- Push happens through [src/vcs/gerritVcsConnector.ts](../../../src/vcs/gerritVcsConnector.ts) (SSH).

### `GerritSshReviewProvider`

- Reviewer-side Gerrit review flow is SSH-only.
- [src/connectors/gerritSshReviewProvider.ts](../../../src/connectors/gerritSshReviewProvider.ts) owns change queries, diff retrieval, review posting, and reviewer-account filtering.
- `getInterPatchsetDiff(changeId, fromPatchset, toPatchset)` (optional `ReviewProvider` method) shallow-fetches both patchset refs and diffs their tips (`git diff fromTip..toTip`) so re-reviews can surface "what changed since my last review" as a focused delta section in the prompt.

### `PluginIntegrationStreamEventsManager` — [src/connectors/integrationStreamEvents.ts](../../../src/connectors/integrationStreamEvents.ts)

- Generic host-side wrapper that groups active integrations by provider, discovers which descriptors expose `capabilities.code_review.streamEvents`, and delegates reconciliation/status to the provider-specific manager for each integration.
- Keeps stream support descriptor-driven instead of hard-coding Gerrit in `src/index.ts`, so future integrations can opt into the same live event-stream lifecycle.

### `GerritStreamEventsManager` — [src/connectors/gerritStreamEvents.ts](../../../src/connectors/gerritStreamEvents.ts)

- Gerrit-specific stream manager used by the generic `integrationStreamEvents` wrapper when the `gerrit` descriptor exposes `streamEvents`.
- Host-side runtime listener that spawns `ssh ... gerrit stream-events` once per active Gerrit integration.
- Routes `change-merged` / `change-abandoned` into the orchestrator and `patchset-created` / `reviewer-added` / `comment-added` into both feedback checks and, when `reviewerAccountId` is configured, the review trigger.
- Applies the same CI/vote classification as SSH polling, including `ci-failure-*` IDs for actionable failure events.
- Maintains in-memory connection state (`connected`, `reconnecting`, last event, reconnect count, last error) for the admin dashboard.

### `GitlabMergeRequestConnector` — [src/connectors/gitlabMergeRequestConnector.ts](../../../src/connectors/gitlabMergeRequestConnector.ts)

- PAT auth.
- The GitLab project selector can come from the VE project repo binding (`repoKey`) rather than from the integration row.
- Uses MR notes as the comment surface; thread resolution via the discussion API.
- Push happens through [src/vcs/gitlabVcsConnector.ts](../../../src/vcs/gitlabVcsConnector.ts) (HTTPS + REST).

### `GitLabMergeRequestReviewProvider` — [src/connectors/gitlabMergeRequestReviewProvider.ts](../../../src/connectors/gitlabMergeRequestReviewProvider.ts)

- Reviewer-side `ReviewProvider` (`kind = "gitlab"`) that lets VE act as a reviewer on GitLab MRs, mirroring the Gerrit/GitHub providers.
- Built via the `gitlab` descriptor's `createReviewer`; resolves base URL, OAuth/PAT token, and project id (with the VE-project repo binding as the source of truth and `config.projectId` as a legacy fallback).
- `changeId` accepts `project#iid` or a legacy bare `iid` (which falls back to the bound project).
- `getChangeDetails` / `getChangeDiff` read the MR and its `/changes`; `postReviewComments` / `postReviewWithComments` / `vote` all funnel through one `submitReview` that posts inline `/discussions` (using the MR `diff_refs` for line positioning), folds out-of-diff or overflow findings into a summary `/notes`, and approves/unapproves best-effort via `/approve` / `/unapprove`.
- Inline lines are validated against the new-file line numbers parsed from each hunk; comments that don't land on an added line are folded into the summary.

### Discussion-thread replies (all review providers)

- `ReviewProvider` exposes two optional methods — `getDiscussionThreads(changeId)` and `postThreadReply(changeId, revision, threadId, message)` — that let VE answer open human review discussions in the same pass that produces inline comments. Providers that omit either method skip the reply flow entirely.
- `getDiscussionThreads` returns `ReviewDiscussionThread[]` (each with `threadId`, optional `file`/`line` anchor, `resolved` flag, and a `comments[]` list tagged with `isOwn`). The orchestrator drops resolved threads, threads with no human comment, and threads whose latest human message is already recorded in the `review_thread_replies` ledger.
- **GitLab** (`gitlabMergeRequestReviewProvider`): reads `/discussions`, tags `isOwn` via `/api/v4/user`, and treats a discussion as resolved only when all resolvable notes are resolved; `postThreadReply` POSTs to `/discussions/:id/notes`.
- **GitHub** (`githubReviewProvider`): uses the GraphQL API — `reviewThreads { isResolved, comments }` (paginated) for fetch and the `addPullRequestReviewThreadReply` mutation for replies; `isOwn` is tagged via `viewer { login }`. The GraphQL endpoint is derived from the REST `apiBaseUrl` (`/api/v3` → `/api/graphql`, `api.github.com` → `api.github.com/graphql`).
- **Gerrit** (`gerritSshReviewProvider` + `gerritSshClient.getDiscussionComments`): groups SSH comments into synthetic threads keyed `gerrit-line:<file>:<line>` (inline) or `gerrit-change` (change-level); `resolved` is always `false` (SSH exposes no resolution flag — the ledger prevents re-replies). `postThreadReply` posts a change message for change-level threads or a new inline comment at the parsed `file:line` (SSH cannot set `in_reply_to`).

## Comment dedup

`feedbackProcessor.extractNewFeedback` queries `processed_comments` (per task) and only forwards comments whose IDs have not been processed yet. After a successful retry cycle the IDs are inserted to prevent loops.

## Mocking in tests

```ts
const ticketing = {
  getAssignedTickets: vi.fn().mockResolvedValue([{ id: "42", title: "…" }]),
  getTicket: vi.fn().mockResolvedValue({ id: "42", title: "…", description: "" }),
  transitionStatus: vi.fn(),
  addNote: vi.fn(),
  closeTicket: vi.fn(),
};
```

The orchestrator/integration tests typically wire mocks via the plugin manager rather than constructing connectors directly.

## Adding a new provider

1. Implement the `TicketConnector` or `ReviewConnector` interface (optionally extending `AbstractTicketConnector`).
2. Add (or extend) a unified provider descriptor in `src/plugins/descriptors/` and wire the relevant capability factory (`capabilities.issue_tracking.createConnector` / `capabilities.code_review.createConnector`); register the descriptor in `src/plugins/init.ts`.
3. If it pushes code, add a matching connector in `src/vcs/` and wire `capabilities.source_control.createVcsConnector` into the descriptor.
4. Add unit tests mirroring `gitlabIssueConnector.test.ts` / `gitlabMergeRequestConnector.test.ts`.
5. Update [connectors.md](connectors.md) and [plugins.md](plugins.md).

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [plugins.md](plugins.md) — descriptor factories that produce these connectors
- [vcs.md](vcs.md) — host-side push layer paired with review connectors
- [orchestrator.md](orchestrator.md) — caller of ticket / review connectors
- [gitlab-integration.md](../gitlab-integration.md) — GitLab-specific reference
