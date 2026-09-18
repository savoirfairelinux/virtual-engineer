# Modules — VCS

**Source:** [src/vcs/](../../../src/vcs/).

The VCS layer is host-owned. The agent sandbox may edit files and create local commits, but the host still controls the final push and keeps review-system credentials outside the sandbox. Push runs directly against the host workspace directory downloaded from the sandbox — there is no helper container and no Docker volume.

## Asynchronous Git runner

- `gitRunner.ts` defines the narrow `GitRunner.run(args, options)` contract and typed `GitCommandError`. The runner executes one Git command; clone/push/commit workflows remain connector-owned.
- `nodeGitRunner.ts` uses `child_process.execFile` without a shell. Callers can set `cwd`, environment, timeout, `AbortSignal`, and output limit; the default output cap is 1 MiB.
- The runner is **hardened by default**: it wraps every argv with `trustedGitArgs()` and every environment with `trustedGitEnv()` from [src/utils/gitExec.ts](../../../src/utils/gitExec.ts), pinning `-c core.hooksPath=/dev/null`, `-c include.path=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_CONFIG_SYSTEM=/dev/null`. This neutralises hook/config code execution planted in a repository the agent wrote to. `src/workspace/hostGitExecutor.ts` applies the same two helpers to its own `execFile` calls.
- Failures distinguish non-zero exit, timeout, cancellation, output-limit breach, and spawn errors. Captured stdout/stderr are bounded and passed through the shared redactor before being returned or attached to errors; it removes URL userinfo, sensitive query parameters, token-shaped values, and non-HTTP/schemeless credential forms. Human-facing error messages include at most 500 characters of sanitized detail; environment values and command arguments are never included in error messages.
- Timeout policy is caller-owned. The runner accepts a per-command timeout or constructor default but imposes none when neither is set.
- `VcsConnectorFactory` owns one shared `NodeGitRunner` and injects it through `SourceControlRuntimeContext` into descriptor-created connectors. Tests can inject a deterministic runner through the factory constructor.
- Gerrit, GitLab, and GitHub host workflows await the runner instead of blocking the Node event loop. Clone and push commands retain a five-minute timeout; command ordering, SSH environments, and authenticated-remote restoration remain connector-owned. Clone URLs are validated before git runs: GitHub/GitLab accept only HTTPS URLs on the configured host, while Gerrit accepts only configured-host SSH or scp-style URLs; local paths, `ext::` values, option-like values, unexpected hosts, and query/fragment-bearing URLs are rejected. Clone argv places `--` before the repository URL, and Gerrit's SSH command pins the configured port.

## Interface — `vcsConnector.ts`

```ts
interface VcsConnector {
  /** Push agent-created commits directly without a host commit step. */
  pushDirect?(
    repoDir: string,
    ref: string,
    topic?: string,
    reviewerEmails?: string[]
  ): Promise<VcsPushResult>;
  /** Read-only lookup used by identity repair; must fail on ambiguity. */
  findExistingReview?(
    sourceBranch: string,
    targetBranch: string
  ): Promise<VcsPushResult | null>;
}
```

The optional feedback methods use the shared `ReviewComment` contract. Built-in VCS fallbacks that return comments attach `reviewSystem` (`gerrit`, `gitlab`, or `github`); the orchestrator emits human review feedback with the generic `review_comment` source.

There is **no** `push()` method any longer — the commit-creating legacy path and its `VolumeExecOptions` parameter were deleted. `pushDirect` is the only push path.

All built-in project push targets implement `pushDirect`, and `Orchestrator.pushProjectChanges()` requires it. The worker normalizes agent-created commits and injects missing Change-Ids only when `useChangeIdContinuity` is true (Gerrit); configured ticket trailers remain provider-independent. The host then pushes the existing commit chain from the downloaded workspace and does not create another commit.

`pushProjectChanges()` only invokes git in repository sub-paths reported by `WorkspaceRunner.listTrustedRepoPaths()` — directories VE cloned itself and whose `.git` metadata was rebuilt from host-trusted remotes. Workspace preparation normally aborts before agent execution when any configured clone fails; the trusted-path check is a second defensive boundary that still refuses an unrecognized directory rather than handing it credentials.

`VcsPushResult.changeId` is the provider's canonical identity: a Gerrit Change-Id, `project#iid` for GitLab, or `owner/repo#number` for GitHub. Gerrit stores one `change_per_repository` row per commit; branch-based providers store one row per pushed target regardless of commit count. Every configured target is required: a clone, connector, or push failure prevents `IN_REVIEW`. A retry target with no new commits preserves its prior review row rather than overwriting it with `NO_CHANGE` or a cycle-local failure. Each target derives its ref from its own connector; only the primary target reuses the task-level `push_ref` compatibility mirror. Gerrit retry results are matched back to absolute commit indices by Change-Id, then subject hash, so a cycle that amends only a later change cannot renumber or orphan the rest of the chain. After every target is durably pushed, preserved, or `NO_CHANGE`, the first review-bearing result by `commitOrder` is copied into the legacy task-level `tasks.gerrit_change_id` / `tasks.review_url` compatibility fields for fallback polling.

## Implementations

### `gerritVcsConnector.ts`
- Pushes via SSH: `git push <ssh-url> HEAD:refs/for/<branch>%topic=...`.
- Reuses `existingChangeId` to keep the same Gerrit change across patchsets.
- Uses SSH for change-status lookup and comment-thread follow-up (`gerrit query`, `gerrit review --json`) instead of Gerrit REST credentials.
- `baseUrl` is optional and used only to build clickable review URLs.
- Requires `gerrit_ssh_host`, `gerrit_ssh_port`, `gerrit_username`, `gerrit_ssh_key_path` from the resolved Gerrit integration.
- `pushDirect(repoDir, ref, topic, reviewerEmails)`: pushes HEAD via SSH with one Gerrit option suffix containing the topic and one `r=<email>` entry per configured reviewer. Existing ref options are extended with commas rather than a second `%`. Returns a `VcsPushResult` with the Change-Id parsed from the commit footer.

### `gitlabVcsConnector.ts`
- Pushes via HTTPS using the project access token.
- Creates or updates a Merge Request via the REST API; reuses the same source branch when `existingChangeId` is set.
- The target GitLab project can come either from legacy integration config (`projectId`) or from the VE project push-target binding (`repoKey`) passed through `vcsFactory`.
- Returns the MR web URL.
- Reviewer emails are looked up through the Users API and matched exactly, case-insensitively, against visible `email` or `public_email` values. Matched IDs are included as `reviewer_ids`; unmatched or inaccessible addresses are logged and skipped. A 409 existing-MR path updates the existing MR when at least one reviewer resolves.
- `pushDirect(repoDir, ref, topic, reviewerEmails)`: force-pushes the feature branch and creates or updates the MR. `topic` is ignored because GitLab does not use Gerrit topics. Resets the remote URL after push to avoid token leakage.
- Returns `project#iid` and implements read-only exact-one branch lookup for repair/reconciliation. Both canonical and legacy bare IID values remain accepted by status/comment methods.

### `githubVcsConnector.ts`
- HTTP-based clone and push for GitHub, mirroring the GitLab design: clones via HTTPS with the token in the remote URL, pushes a feature branch, and creates or updates a Pull Request via the GitHub REST API (`apiBaseUrl` supports both `api.github.com` and GHE `/api/v3`).
- `reviewSystemLabel = "github"`, `useChangeIdContinuity = false`.
- `buildPushSpec(baseBranch, taskId, ticketTitle)` derives the branch ref via `buildFeatureBranchRef` (no Gerrit topic).
- Returns `owner/repo#number` and implements read-only exact-one branch lookup for repair/reconciliation. Status lookup accepts canonical and legacy bare PR numbers.
- Reviewer-email configuration is not supported because GitHub's request-reviewers API requires usernames. The admin API rejects non-empty reviewer-email lists for GitHub push targets.
- Config: `apiBaseUrl`, `host`, `owner`, `repo`, `token`, git author identity, optional `targetBranch` (default `main`).

### `branchNaming.ts`
- Shared branch/topic naming helpers: `buildFeatureBranchRef(taskId, ticketTitle)` → `feature/<shortId>-<slug>` (falls back to `feature-<taskId>` when the title is empty) and `buildGerritTopic(taskId, ticketTitle)` → `VE-<shortId>-<slug>` (falls back to `VE-<taskId>`). Slugs are NFKD-normalized, lowercased, and capped at 40 chars.

### `vcsFactory.ts`
- Fully generic: dispatches entirely via `capabilities.source_control.createVcsConnector` on the provider descriptor — no type-specific `if`/`switch` branches exist.
- Checks VCS capability (`capabilities.source_control.createVcsConnector` presence) **before** schema validation, so non-VCS integration types get a clear `"not a VCS push target"` error rather than a schema-validation error.
- Supports an optional project binding context (`ticketProjectKey` / `repoKey`) so project-mode runtime paths can specialize providers like GitLab without mutating integration rows.
- Passes an optional `SourceControlRuntimeContext` as the fourth descriptor-factory argument. Its shared `gitRunner` is reused by cached integration-global connectors and project-bound connectors.
- Used by `src/index.ts` and refreshed through `refreshRuntimeDependencies()`.

## Identity repair

`npm run repair:change-identities` is dry-run by default. It opens an existing database read-only, derives each target's ref from its own connector (using the task mirror only for the primary target), and resolves branch-provider reviews through `findExistingReview()`. Legacy branch-provider `NO_CHANGE` rows are verified against the provider rather than trusted. The command reports clean, repairable, or blocked tasks without creating, migrating, backfilling, or seeding data. Run it with polling/webhook intake stopped. After reviewing a clean dry-run, `npm run repair:change-identities -- --apply` idempotently collapses every extra GitLab/GitHub commit-index row (including stale `MERGED`/`ABANDONED` rows), repairs legacy `integration_id` / `review_system` routing metadata in place for every Gerrit commit row, and repairs the task-level mirror in one SQLite transaction per task. If any target is missing or ambiguous, the command performs no writes for that task and exits non-zero.

## Tests

- `tests/unit/vcsConnector.test.ts`
- `tests/unit/vcsFactory.test.ts`
- `tests/unit/gerritVcsConnector.test.ts`
- `tests/unit/gitlabVcsConnector.test.ts`
- `tests/unit/githubVcsConnector.test.ts`
- `tests/unit/branchNaming.test.ts`
- `tests/unit/nodeGitRunner.test.ts`
- `tests/unit/changeIdentityRepair.test.ts`

## Adding a new VCS

1. Implement `VcsConnector` in a new file under `src/vcs/`.
2. Add `capabilities.source_control.createVcsConnector(config, integration, context?, runtime?) → VcsConnector` to the integration's descriptor (e.g. `src/plugins/descriptors/<name>.ts`). Pass `runtime?.gitRunner` into the connector; `vcsFactory` will pick it up automatically.
3. Add unit tests; inject `RecordingGitRunner` from `tests/unit/helpers/recordingGitRunner.ts` rather than running real Git. There is no Docker volume module to mock — host-side git plumbing lives in `src/workspace/hostGitExecutor.ts` and connector git in `src/vcs/nodeGitRunner.ts`.

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [plugins.md](plugins.md) — descriptor registry that produces VCS connectors via `source_control` capability
- [connectors.md](connectors.md) — review-side connectors that pair with VCS push
- [orchestrator.md](orchestrator.md) — caller of the required project-mode `pushDirect` path
