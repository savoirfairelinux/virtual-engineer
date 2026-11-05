# Modules — VCS

**Source:** [src/vcs/](../../../src/vcs/).

The VCS layer is host-owned. The agent sandbox may edit files and create local commits, but the host still controls the final push and keeps review-system credentials outside the sandbox. Push runs directly against the host workspace directory downloaded from the sandbox — there is no helper container and no Docker volume.

## Asynchronous Git runner

- `gitRunner.ts` defines the narrow `GitRunner.run(args, options)` contract and typed `GitCommandError`. The runner executes one Git command; clone/push/commit workflows remain connector-owned.
- `nodeGitRunner.ts` uses `child_process.execFile` without a shell. Callers can set `cwd`, environment, timeout, `AbortSignal`, and output limit; the default output cap is 1 MiB.
- The runner is **hardened by default**: it wraps every argv with `trustedGitArgs()` and every environment with `trustedGitEnv()` from [src/utils/gitExec.ts](../../../src/utils/gitExec.ts), pinning `-c core.hooksPath=/dev/null`, `-c include.path=/dev/null`, `-c protocol.ext.allow=never`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_CONFIG_SYSTEM=/dev/null`. These settings are defense in depth, not complete local-config sanitization. `src/workspace/hostGitExecutor.ts` applies the same two helpers to its own `execFile` calls.
- Failures distinguish non-zero exit, timeout, cancellation, output-limit breach, and spawn errors. Captured stdout/stderr are bounded and passed through the shared redactor before being returned or attached to errors; it removes URL userinfo, sensitive query parameters, token-shaped values, and non-HTTP/schemeless credential forms. Human-facing error messages include at most 500 characters of sanitized detail; environment values and command arguments are never included in error messages.
- Timeout policy is caller-owned. The runner accepts a per-command timeout or constructor default but imposes none when neither is set.
- Project workspace clones performed by `HostGitExecutor` are a separate host-side path: they use `--depth 1`, allow up to three attempts for recognized transient transfer/pack errors and per-attempt timeouts, enforce a five-minute timeout per attempt, and remove partial destinations before retrying. The workspace root itself is preserved when it is the clone destination.
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
  /** Read-only source-branch lookup across all targets/states; null if absent, error if several. */
  findExistingReview?(sourceBranch: string): Promise<ExistingReview | null>;
}
```

The optional feedback methods use the shared `ReviewComment` contract. Built-in VCS fallbacks that return comments attach `reviewSystem` (`gerrit`, `gitlab`, or `github`); the orchestrator emits human review feedback with the generic `review_comment` source.

There is **no** `push()` method any longer — the commit-creating legacy path and its `VolumeExecOptions` parameter were deleted. `pushDirect` is the only push path.

All built-in project push targets implement `pushDirect`, and `Orchestrator.pushProjectChanges()` requires it. The worker normalizes agent-created commits and injects missing Change-Ids and configured ticket trailers before returning; the host then pushes the existing commit chain from the downloaded workspace. It does not create another commit.

`pushProjectChanges()` only invokes git in repository sub-paths reported by `WorkspaceRunner.listTrustedRepoPaths()` — directories VE cloned itself and whose `.git` metadata was rebuilt from host-trusted remotes. A push target whose clone failed is agent-authored and is refused rather than handed credentials.

After coding-workspace download, all recorded repositories must pass filesystem-only standalone-layout validation before any metadata is rebuilt or host Git runs. Shared-directory markers (`commondir`, `gitdir`), gitfiles, symlinks, missing/bare layouts, malformed or oversized (over 4 KiB) `HEAD` files, and metadata Git itself could not recognize (unreadable `HEAD`, non-searchable `objects`/`refs`, which would make discovery fall back to a parent repository) fail the coding run. Rebuilding then restores each repository's own credential-free origin and removes sandbox-controlled push URLs, URL rewrites, hooks, alternates, attributes, worktree configuration, and leftover linked-worktree registrations (`worktrees`). See [modules/workspace.md](workspace.md#sandbox-lifecycle-per-cycle).

`VcsPushResult.changeId` is the Gerrit Change-Id, GitLab MR IID, or GitHub PR number (the hosted identifiers are native numeric strings, not commit trailers or repository-qualified IDs). `useChangeIdContinuity` controls persistence: Gerrit keeps one row per commit; GitHub/GitLab keep one row per pushed repository and the exact returned URL. `reviewSystemLabel` remains an opaque stored label.

## Historical hosted change repair

`npm run repair:change-identities` inspects an existing, migrated `DATABASE_PATH` using its database-managed integrations. The default connection is read-only: it does not create a database, run migrations, seed data, push, or create reviews. Optional `--task <id>` restricts the scan.

The tool recognizes legacy `I<40 hex digits>` rows, resolves the recorded integration and current project target, and respects the connector's continuity capability. GitHub/GitLab `findExistingReview()` queries **all** review states from the exact persisted `push_ref` across **every** target branch: the corrupted URL usually lost the number (`/pull/43` and `/pull/42` corrupt to the same `/pull/I…`), and the project target may have changed since the push, so a filter on the current target could hide the original review. More than one review from the branch blocks the target; a unique review is accepted and its `resolvedTargetBranch` is reported, with a note when it differs from the current target. The lookup validates native identifiers, the exact (case-sensitive) source branch and the bound repository (case-insensitive owner/repository on GitHub), and refuses forks or deleted head repositories rather than selecting a result.

Every non-empty URL on an active row must equal the recovered URL or reproduce the known faulty identifier replacement exactly for that row's own identifier; the primary row must carry such a URL. Missing branches/integrations, changed bindings, mixed review systems, conflicting native IDs/terminal statuses, and unproven URLs (including a secondary row pointing to a different review) block application. No ID is inferred from a malformed URL.

Rollout:

1. Deploy the fix, stop VE intake, and back up the database.
2. Run `npm run repair:change-identities` (or append `-- --task <id>`) and review the JSON report.
3. Resolve every blocked target in the selected scope, then run `npm run repair:change-identities -- --apply` (retaining `--task <id>` if selected).
4. Restart intake and verify status/feedback polling uses the native review identifiers.

Application revalidates complete task, integration, push-target, and change-row snapshots in one immediate SQLite transaction before any writes. It fixes the primary row and marks proven duplicate hosted rows `ORPHANED`, retaining their IDs and history. A task's legacy mirrored review fields are corrected only when their URL independently proves the same corruption; task state and push reference never change. Genuine Gerrit rows are untouched. Any blocked target prevents all selected repairs; a stale snapshot or write failure rolls back the whole transaction. Exit codes are 0 for a successful scan/application, 2 for blocked targets, and 1 for execution failures.

## Implementations

### `gerritVcsConnector.ts`
- Pushes via SSH: `git push <ssh-url> HEAD:refs/for/<branch>%topic=...`.
- Reuses `existingChangeId` to keep the same Gerrit change across patchsets.
- Uses SSH for change-status lookup and comment-thread follow-up (`gerrit query`, `gerrit review --json`) instead of Gerrit REST credentials.
- `baseUrl` is optional and used only to build clickable review URLs.
- Requires `sshHost`, `sshPort`, and `sshUser` from the resolved Gerrit integration; `sshKeyPath`, `sshAgentPubKeyPath`, and `sshKnownHostsPath` are optional (SSH agent authentication and trust-on-first-use fallbacks).
- Git SSH commands use `buildGerritGitSshCommand()` from the shared Gerrit transport. It validates users/hosts before Git starts, pins the login with `-l`, and POSIX-quotes each option value. Direct SSH commands use `buildGerritSshArgs()` with `--` before the host. Raw and bracketed IPv6 configured hosts work with SSH clone validation and bracketed patchset URLs.
- `pushDirect(repoDir, ref, topic, reviewerEmails)`: pushes HEAD via SSH with one Gerrit option suffix containing the topic and one `r=<email>` entry per configured reviewer. Existing ref options are extended with commas rather than a second `%`. Returns a `VcsPushResult` with the Change-Id parsed from the commit footer.

### `gitlabVcsConnector.ts`
- Pushes via HTTPS using the project access token.
- Creates or updates a Merge Request via the REST API; reuses the same source branch when `existingChangeId` is set.
- The target GitLab project can come either from legacy integration config (`projectId`) or from the VE project push-target binding (`repoKey`) passed through `vcsFactory`.
- Returns the MR web URL.
- Reviewer emails are looked up through the Users API and matched exactly, case-insensitively, against visible `email` or `public_email` values. Matched IDs are included as `reviewer_ids`; unmatched or inaccessible addresses are logged and skipped. A 409 existing-MR path updates the existing MR when at least one reviewer resolves.
- `pushDirect(repoDir, ref, topic, reviewerEmails)`: force-pushes the feature branch and creates or updates the MR. `topic` is ignored because GitLab does not use Gerrit topics. Resets the remote URL after push to avoid token leakage.

### `githubVcsConnector.ts`
- HTTP-based clone and push for GitHub, mirroring the GitLab design: clones via HTTPS with the token in the remote URL, pushes a feature branch, and creates or updates a Pull Request via the GitHub REST API (`apiBaseUrl` supports both `api.github.com` and GHE `/api/v3`).
- `reviewSystemLabel = "github"`, `useChangeIdContinuity = false`.
- `buildPushSpec(baseBranch, taskId, ticketTitle)` derives the branch ref via `buildFeatureBranchRef` (no Gerrit topic).
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

## Tests

- `tests/unit/vcsConnector.test.ts`
- `tests/unit/vcsFactory.test.ts`
- `tests/unit/gerritVcsConnector.test.ts`
- `tests/unit/gitlabVcsConnector.test.ts`
- `tests/unit/githubVcsConnector.test.ts`
- `tests/unit/branchNaming.test.ts`
- `tests/unit/nodeGitRunner.test.ts`

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
