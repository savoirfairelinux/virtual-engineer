# Modules — Connectors

**Source:** [src/connectors/](../../../src/connectors/).

Connectors are HTTP/SSH clients for external systems. They are resolved at runtime by the **plugin manager** (see [plugins.md](plugins.md)) — the orchestrator never imports a concrete connector directly.

## Shared base

### `AbstractTicketConnector` — [src/connectors/baseTicketConnector.ts](../../../src/connectors/baseTicketConnector.ts)

Provides default `transitionToInProgress` / `transitionToInReview` implementations so concrete ticket connectors delegate via `transitionStatus(ticketId, statusId)`.

### `GerritSshClient` — [src/connectors/gerritSshClient.ts](../../../src/connectors/gerritSshClient.ts)

Shared SSH transport and Gerrit protocol helper. Encapsulates `ssh gerrit …` execution, NDJSON parsing, and `buildSshHostKeyOptions()` so that `GerritConnector`, `GerritSshReviewProvider`, `GerritVcsConnector`, and `GerritStreamEventsManager` share a single SSH client rather than duplicating implementation. `buildSshHostKeyOptions()` (via `src/utils/sshHostKeys.ts`) uses strict host-key verification when `knownHostsPath` is configured, otherwise trust-on-first-use (`StrictHostKeyChecking=accept-new`) against the VE-managed `<dirname(DATABASE_PATH)>/ssh/known_hosts`; it never disables verification or uses `/dev/null`. Top-level Jenkins lifecycle notices and vote-only messages are filtered; failed/aborted/unstable builds are retained with `ci-failure-*` IDs for the orchestrator's project-level gate. When resolving inline feedback, the client best-effort reads Gerrit's anonymous comments endpoint and sends `in_reply_to` through `gerrit review --json`, falling back to a fresh resolved comment when no UUID is available.

### `GitLabHttpClient` — [src/connectors/gitlabHttpClient.ts](../../../src/connectors/gitlabHttpClient.ts)

Shared HTTP helper with `Authorization: Bearer` injection, error translation, paginated fetching, and bounded credential redaction for URLs and upstream response bodies. Used by both `GitLabIssueConnector` and `GitLabMergeRequestConnector`, so the same runtime path works for both GitLab PATs and GitLab OAuth access tokens.

## Capabilities

Connectors are unchanged in shape, but they are now produced by **capability factories** on the unified provider descriptors (see [plugins.md](plugins.md)) rather than per-type `createInstance` hooks. A single provider descriptor can expose several domain capabilities.

| Domain capability | Implementations | Factory |
| --- | --- | --- |
| `issue_tracking` | `redmineConnector`, `gitlabIssueConnector`, `githubIssueConnector` | `capabilities.issue_tracking.createConnector` |
| `code_review` | `gerritConnector`, `gerritSshReviewProvider`, `integrationStreamEvents`, `gerritStreamEvents`, `gitlabMergeRequestConnector`, `gitlabMergeRequestReviewProvider`, `githubPullRequestReviewConnector`, `githubReviewProvider` | `capabilities.code_review.{ createConnector, createReviewer, streamEvents, assignmentModes }` |

The `provider` ids are `github | gitlab | gerrit | redmine | copilot | claude | aider | goose | codex | gemini | opencode | cursor`. Repository push/commit lives in [src/vcs/](../../../src/vcs/) via `capabilities.source_control.createVcsConnector` — see [vcs.md](vcs.md). The `copilot`, `claude`, `aider`, `goose`, `codex`, `gemini`, `opencode`, and `cursor` providers expose only `agent_execution` and have no connectors here.

Reviewer-side `ReviewProvider` reads and effects accept an optional `AbortSignal`. GitHub and GitLab forward it to `fetch`; Gerrit forwards it to SSH and temporary Git subprocesses. Multi-request best-effort fallbacks rethrow cancellation instead of folding or suppressing it, so the orchestrator's single review deadline can terminate freshness checks, comments, replies, and votes.

Reviewer decisions are normalized internally as `-1 | 0 | 1`, then translated by each provider. Gerrit always submits the corresponding `Code-Review` label, including `0` to clear a prior vote; GitHub maps them to `REQUEST_CHANGES` / `COMMENT` / `APPROVE`; GitLab maps them to a native `mergeRequestRequestChanges` request / no approval action / approve on both the legacy `vote()`/`postReviewWithComments()` path and the hosted overview; only instances without the native mutation fall back to an advisory REST unapprove. Neutral and positive decisions first clear VE's own previous changes request; a VE user absent from the MR reviewer list has none to clear, while an unknown current user or inaccessible MR fails closed. The agent-facing JSON contract uses provider-native field names (`vote`, `reviewAction`, or `approvalAction`) and is selected from `reviewProvider.kind`.

For hosted GitHub/GitLab reviews, `postReviewOverview()` publishes a formatted English summary, includes direct links for successfully posted inline findings, and leaves folded findings unlinked. Both providers reject a closed change or a head that differs from the reviewed `headSha` before the first provider effect; GitLab also rejects a changes response whose `diff_refs.head_sha` differs. GitLab inline positions use each change's original `old_path` and current `new_path`, so renamed-file findings stay anchorable. It also reports remote publication identity and actual finding URLs to the orchestrator for durable tracking; Gerrit continues using the existing vote/comment contract.

Review-discovery connectors expose `getOpenReviewAssignments(repos)` for manual-assignment polling and may expose `getOpenReviewChanges(repos, since)` for automatic polling and `hasReviewAssignment(changeId)` for persisted `REVIEW_WATCHING` tasks. Automatic projects do not backfill open changes: the GitHub connector finds only PRs updated after the persisted discovery watermark, without requiring VE to be a requested reviewer. Their watcher triggers revision checks without requiring VE to remain in the remote reviewer list. Reviewer providers expose cancellable `isReviewer(changeId)` and additive `ensureReviewerAssignment(changeId)` operations when their descriptor advertises the automatic mode.

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

### `GitHubIssueConnector` — [src/connectors/githubIssueConnector.ts](../../../src/connectors/githubIssueConnector.ts)

- Token auth through `Authorization: Bearer` (GitHub PAT or OAuth token).
- Maps the same orchestrator-facing contract onto GitHub Issues REST endpoints (`GET /repos/:owner/:repo/issues`, paginated).
- Reuses the same `in-progress / in-review / closed` workflow semantics via a single configurable `inProgressLabel` (default `in-progress`); GitHub Issues has no built-in status field, so labels double as workflow state.
- The GitHub owner/repo selector can come from the VE project ticket binding (`ticketProjectKey`) rather than from the integration row.

## Review contract (`ReviewConnector`)

Methods used by the orchestrator:

- `getChange(changeRef)` — resolve change/MR + current patchset.
- `getChangeStatus(changeRef)` → `"OPEN" | "MERGED" | "ABANDONED"`.
- `getUnresolvedComments(changeRef)` — comments with stable IDs for dedup. `ReviewComment.reviewSystem` optionally identifies the producing review system; all built-in Gerrit, GitLab, and GitHub feedback producers populate it, including Gerrit stream comments and GitHub CI check comments.
- `addChangeComment(changeRef, body)`.
- `resolveComments(changeRef, commentIds)`.

### `GerritConnector` — [src/connectors/gerritConnector.ts](../../../src/connectors/gerritConnector.ts)

- SSH-only connector for review feedback and repository discovery.
- Delegates SSH transport to `GerritSshClient`.
- Uses `ssh gerrit query`, `ssh gerrit review`, and `ssh gerrit ls-projects` with `sshHost`, `sshPort`, `sshUser`, and `sshKeyPath`; `knownHostsPath` is optional (strict when set, trust-on-first-use otherwise).
- `baseUrl` is optional and used only to build clickable Gerrit web links; review operations no longer depend on REST credentials.
- `listRepositoriesViaSsh()` is the shared SSH discovery helper used by integration testing, admin discovery, and runtime connection checks.
- `listBranchesViaSsh(ssh, repoKey)` runs `git ls-remote --heads ssh://…/<repoKey>` (with `GIT_SSH_COMMAND` carrying the key + host-key options) and parses `refs/heads/*` into branch names; surfaced via `GerritSshConnector.listBranches()` and the descriptor `discoverBranches` hook.
- Gerrit polling and stream comments carry `reviewSystem = "gerrit"`; CI build failures retain that provenance while the feedback processor classifies them as `ci_failure`.
- Push happens through [src/vcs/gerritVcsConnector.ts](../../../src/vcs/gerritVcsConnector.ts) (SSH).

### `GerritSshReviewProvider`

- Reviewer-side Gerrit review flow is SSH-only.
- [src/connectors/gerritSshReviewProvider.ts](../../../src/connectors/gerritSshReviewProvider.ts) owns change queries, diff retrieval, review posting, and reviewer-account filtering.
- `isReviewer()` reads Gerrit's reviewer list fail-closed; `ensureReviewerAssignment()` uses `gerrit set-reviewers --add` and never replaces existing reviewers. Stream patchset events reach the per-project assignment policy; trivial rebases remain excluded.
- `getInterPatchsetDiff(changeId, fromPatchset, toPatchset)` (optional `ReviewProvider` method) shallow-fetches both patchset refs and diffs their tips (`git diff fromTip..toTip`) so re-reviews can surface "what changed since my last review" as a focused delta section in the prompt.

GitHub PR review diff retrieval paginates the `/files` listing (100 files/page) and rejects the API's 3,000-file ceiling or a missing `patch` on a file with changed lines (oversized text diffs) rather than approving from an incomplete response. Files GitHub lists without a patch and with zero changed lines (binary files, pure renames/mode changes) are kept with an empty patch. Its optional inter-patchset comparison applies the same patch rule, rejects GitHub's 300-file cap, and falls back to the complete PR diff. GitLab MR review rejects `/changes` responses reporting `overflow` or missing patches rather than reviewing a subset.

### `PluginIntegrationStreamEventsManager` — [src/connectors/integrationStreamEvents.ts](../../../src/connectors/integrationStreamEvents.ts)

- Generic host-side wrapper that groups demanded active integrations by provider, discovers which descriptors expose `capabilities.code_review.streamEvents`, and delegates reconciliation, targeted backfill, and status to the provider-specific manager for each integration.
- Keeps stream support descriptor-driven instead of hard-coding Gerrit in `src/index.ts`, so future integrations can opt into the same live event-stream lifecycle.

### `GerritStreamEventsManager` — [src/connectors/gerritStreamEvents.ts](../../../src/connectors/gerritStreamEvents.ts)

- Gerrit-specific stream manager used by the generic `integrationStreamEvents` wrapper when the `gerrit` descriptor exposes `streamEvents`.
- Host-side runtime listener that spawns `ssh ... gerrit stream-events` once per active Gerrit integration demanded by an enabled review project or a non-terminal task with an external change. A coding project with no pushed change does not open a listener.
- Runs the capped assignment backfill on first connection and on explicit project-change requests. Each assigned change is triggered by its Gerrit change number. Repeat requests share one in-flight query, requests received while connecting wait for the first stdout byte, and no backfill request restarts the SSH process.
- Cancels pending reconnect timers as soon as demand disappears, resets reconnect attempts when connection configuration changes, and bounds shutdown draining so stalled provider work cannot block process exit indefinitely.
- Routes `change-merged` / `change-abandoned` into the orchestrator, `comment-added` into coding feedback checks, and `patchset-created` / `reviewer-added` into both feedback checks and the review trigger. Coding feedback keeps the Change-Id (`change.id`) that VE pushes persist. Review triggers use Gerrit's change number (`change.number`) and fall back to the Change-Id only when the number is missing: cherry-picks keep one Change-Id on several branches, so `change:<Change-Id>` can match the wrong change. Merged/abandoned events are routed once with the Change-Id and once with the change number, so coding tasks and number-keyed review tasks both close; each route's failure is logged without skipping the other. For `change-merged`, Gerrit's `change.project` is forwarded with the integration and each identifier; the orchestrator resolves it against the configured push target and ignores missing or ambiguous matches.
- Applies the same CI/vote classification as SSH polling, including `ci-failure-*` IDs for actionable failure events.
- Maintains in-memory connection state (`connected`, `reconnecting`, last event, reconnect count, last error) for the admin dashboard.

### `GitlabMergeRequestConnector` — [src/connectors/gitlabMergeRequestConnector.ts](../../../src/connectors/gitlabMergeRequestConnector.ts)

- PAT auth.
- The GitLab project selector can come from the VE project repo binding (`repoKey`) rather than from the integration row.
- Uses MR notes as the comment surface; thread resolution via the discussion API. Returned discussions carry `reviewSystem = "gitlab"`, so opaque discussion IDs are not mistaken for Gerrit comments.
- Implements `ReviewDiscoveryConnector` through `reviewer_id`-filtered, paginated MR queries and supports qualified `project#iid` assignment checks for manual polling.
- Push happens through [src/vcs/gitlabVcsConnector.ts](../../../src/vcs/gitlabVcsConnector.ts) (HTTPS + REST).

### `GitLabMergeRequestReviewProvider` — [src/connectors/gitlabMergeRequestReviewProvider.ts](../../../src/connectors/gitlabMergeRequestReviewProvider.ts)

- Reviewer-side `ReviewProvider` (`kind = "gitlab"`) that lets VE act as a reviewer on GitLab MRs, mirroring the Gerrit/GitHub providers.
- Built via the `gitlab` descriptor's `createReviewer`; resolves base URL, OAuth/PAT token, and project id (with the VE-project repo binding as the source of truth and `config.projectId` as a legacy fallback).
- `changeId` accepts `project#iid` or a legacy bare `iid` (which falls back to the bound project).
- `isReviewer()` resolves `/user` and compares MR reviewers; `ensureReviewerAssignment()` updates `reviewer_ids` as a union, preserving all existing reviewers.
- `getChangeDetails` / `getChangeDiff` read the MR and its `/changes`; `postReviewComments` / `postReviewWithComments` / `vote` all funnel through one `submitReview` that posts inline `/discussions` (using the MR `diff_refs` for line positioning), folds out-of-diff or overflow findings into a summary `/notes`, and approves/unapproves best-effort via `/approve` / `/unapprove`.
- Inline lines are validated against the new-file line numbers parsed from each hunk; comments that don't land on an added line are folded into the summary.
- Hosted negative reviews use GitLab's `mergeRequestRequestChanges` GraphQL mutation when available and confirm the reviewer's `REQUESTED_CHANGES` state. Unsupported tiers/instances get an explicitly advisory overview (no false claim to block merging). Positive/neutral reviews remove VE's previous native changes request with `mergeRequestDestroyRequestedChanges` when present; mutation failures are surfaced rather than silently treated as success. If the reviewer-state field is absent, VE proceeds only after a validation-only probe confirms both native mutations are absent; transient and permission errors still fail closed. Inline discussions are created before the overview note so it can link to their `#note_<id>` URLs; invalid locations and inline-only 400/422 failures fold into the note without claiming a link.

### `GitHubPullRequestReviewConnector` — [src/connectors/githubPullRequestReviewConnector.ts](../../../src/connectors/githubPullRequestReviewConnector.ts)

- Implements `ReviewConnector` (feedback/status/merge polling) and `ReviewDiscoveryConnector` (open-PR review-assignment discovery for `pollReviewProjects()`).
- `getOpenReviewChanges(repos, since)` pages open PRs sorted by `updated_at` and finds new/updated changes after the automatic polling watermark, regardless of requested reviewers; it returns `{ changes, complete }`, where each change includes the head SHA and `updatedAt`, and `complete` is false when any repository page fails (already collected changes are still returned). The review orchestrator assigns VE before executing.
- `hasReviewAssignment(changeId)` fetches one PR and returns whether VE is still listed in `requested_reviewers`; this keeps polling-based re-reviews opt-in to the current GitHub reviewer assignment.
- Accepts numeric PR ids for legacy single-repository calls and repository-qualified ids in the `owner/repo#number` format used by GitHub webhooks and assignment discovery; qualified ids must match the connector's project-bound repository before an API request is made.
- `getUnresolvedComments` requires an external `CHANGES_REQUESTED` review and filters both inline and general PR comments to authors who submitted a review; comments from other collaborators and VE's own comments are ignored.
- Inline, general, and CI check comments carry `reviewSystem = "github"`; the feedback processor uses the generic `review_comment` source for human review comments rather than inferring the provider from numeric or prefixed IDs.
- Reads PR state/merge status, unresolved review comments, and GitHub Checks API run/annotation data so `react_to_ci_failures` can classify `ci-run-*` / CI failure events the same way Gerrit does.
- Token auth through `Authorization: Bearer` (GitHub PAT or OAuth token); `apiBaseUrl` supports both `api.github.com` and GitHub Enterprise `/api/v3` hosts.

### `GitHubReviewProvider` — [src/connectors/githubReviewProvider.ts](../../../src/connectors/githubReviewProvider.ts)

- Reviewer-side `ReviewProvider` (`kind = "github"`) that lets VE act as a reviewer on GitHub Pull Requests, mirroring the Gerrit/GitLab providers.
- `isReviewer()` reads `requested_reviewers`; `ensureReviewerAssignment()` uses `POST /requested_reviewers` with the configured login or `/user` identity. GitHub removes a requested reviewer after that reviewer submits, so automatic mode re-requests VE on a later head revision.
- `getChangeDetails` / `getChangeDiff` read the PR and its file list (`/pulls/:number/files`, unified `patch` per file); `postReviewComments` / `postReviewWithComments` / `vote` submit through the PR Reviews API, mapping normalized `-1 | 0 | 1` decisions to `REQUEST_CHANGES` / `COMMENT` / `APPROVE`.
- Hosted overviews create a pending review pinned to the analyzed head SHA with a non-empty placeholder body, match its returned inline comments by path and body in submission order (the review comments endpoint omits `line` for pending comments; a returned line must still agree) to GitHub `html_url` discussion anchors, verify the PR is still open at that head, then submit the decision with the linked overview as the submit-event `body` (the draft is never edited via `PUT`, which returns 404 for OAuth integration tokens). Pre-submission failures delete the pending review when possible; a possibly submitted review is not deleted on an ambiguous submit error. Findings only enter the local posted ledger after submission succeeds. Binary files and files/lines without a confirmed text hunk are folded into the overview without invented links. Both diff loading and overview anchoring use bounded, paginated PR-file retrieval and fail explicitly at GitHub's 3,000-file cap rather than trusting an incomplete review.
- `getInterPatchsetDiff` resolves the previously reviewed SHA from the PR commit list and uses GitHub's `compare/{from}...{head}` endpoint to provide the delta on re-review. SHA-derived patchset identifiers are compared for equality, not chronological ordering.
- Discussion-thread replies use the GraphQL API (`reviewThreads { isResolved, comments }` for fetch, `addPullRequestReviewThreadReply` mutation for replies); the GraphQL endpoint is derived from the REST `apiBaseUrl`.

### Discussion-thread replies (all review providers)

- `ReviewProvider` exposes two optional methods — `getDiscussionThreads(changeId)` and `postThreadReply(changeId, revision, threadId, message)` — that let VE answer open human review discussions in the same pass that produces inline comments. Providers that omit either method skip the reply flow entirely.
- `getDiscussionThreads` returns `ReviewDiscussionThread[]` (each with `threadId`, optional `file`/`line` anchor, `resolved` flag, and a `comments[]` list tagged with `isOwn`). The orchestrator drops resolved threads, threads with no human comment, and threads whose latest human message is already recorded in the `review_thread_replies` ledger.
- **GitLab** (`gitlabMergeRequestReviewProvider`): reads `/discussions`, tags `isOwn` via `/api/v4/user`, and treats a discussion as resolved only when all resolvable notes are resolved; `postThreadReply` POSTs to `/discussions/:id/notes`.
- **GitHub** (`githubReviewProvider`): uses the GraphQL API — `reviewThreads { isResolved, comments }` (paginated) for fetch and the `addPullRequestReviewThreadReply` mutation for replies; thread authors are restricted to users present in the PR's submitted reviews, with `isOwn` tagged via `viewer { login }`. The GraphQL endpoint is derived from the REST `apiBaseUrl` (`/api/v3` → `/api/graphql`, `api.github.com` → `api.github.com/graphql`).
- **Gerrit** (`gerritSshReviewProvider` + `gerritSshClient.getDiscussionComments`): groups SSH comments into synthetic threads keyed `gerrit-line:<file>:<line>` (inline) or `gerrit-change` (change-level); `resolved` is always `false` (SSH exposes no resolution flag — the ledger prevents re-replies). `postThreadReply` posts a change message for change-level threads or a new inline comment at the parsed `file:line` (SSH cannot set `in_reply_to`).

## Comment dedup

`feedbackProcessor.extractNewFeedback` queries `processed_comments` (per task) and only forwards comments whose IDs have not been processed yet. After a successful retry cycle the IDs are inserted to prevent loops.
Review provenance is transient: `FeedbackItem.source` is `review_comment` for human review comments, while `FeedbackItem.reviewSystem` copies the optional provider identity from `ReviewComment`; CI failures keep `ci_failure`. Neither field changes the `(taskId, comment.id)` deduplication key.

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
