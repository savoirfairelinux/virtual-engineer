# Modules — VCS

**Source:** [src/vcs/](../../../src/vcs/).

The VCS layer is host-owned. The agent container may edit files and create local commits, but the host still controls the final push and keeps review-system credentials outside the container.

## Asynchronous Git runner

- `gitRunner.ts` defines the narrow `GitRunner.run(args, options)` contract and typed `GitCommandError`. The runner executes one Git command; clone/push/commit workflows remain connector-owned.
- `nodeGitRunner.ts` uses `child_process.execFile` without a shell. Callers can set `cwd`, environment, timeout, `AbortSignal`, and output limit; the default output cap is 1 MiB.
- Failures distinguish non-zero exit, timeout, cancellation, output-limit breach, and spawn errors. Captured stdout/stderr are bounded and passed through URL/token redaction before being returned or attached to errors; environment values and command arguments are never included in error messages.
- Timeout policy is caller-owned. The runner accepts a per-command timeout or constructor default but imposes none when neither is set.
- `VcsConnectorFactory` owns one shared `NodeGitRunner` and injects it through `SourceControlRuntimeContext` into descriptor-created connectors. Tests can inject a deterministic runner through the factory constructor.
- Gerrit, GitLab, and GitHub host workflows await the runner instead of blocking the Node event loop. Clone and push commands retain a five-minute timeout; command ordering, SSH environments, and authenticated-remote restoration remain connector-owned.

## Interface — `vcsConnector.ts`

```ts
interface VcsConnector {
  /** Legacy connector operation that may create a commit before pushing. */
  push(
    repoDir: string,
    ref: string,
    message: string,
    changeId?: string,
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult>;

  /** Push agent-created commits directly without a host commit step. */
  pushDirect?(
    repoDir: string,
    ref: string,
    topic?: string,
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult>;
}
```

All built-in project push targets implement `pushDirect`, and `Orchestrator.pushProjectChanges()` requires it. The worker normalizes agent-created commits and injects missing Change-Ids and configured ticket trailers before returning; the host then pushes the existing commit chain through a credential-bearing helper container. It does not create another commit.

`VcsPushResult.changeId` is the Gerrit Change-Id, GitLab MR IID, or GitHub PR identifier. Per-repository results are stored in `change_per_repository`; the legacy task-level `tasks.gerrit_change_id` and `tasks.review_url` fields retain the primary result.

## Implementations

### `gerritVcsConnector.ts`
- Pushes via SSH: `git push <ssh-url> HEAD:refs/for/<branch>%topic=...`.
- Reuses `existingChangeId` to keep the same Gerrit change across patchsets.
- Uses SSH for change-status lookup and comment-thread follow-up (`gerrit query`, `gerrit review --json`) instead of Gerrit REST credentials.
- `baseUrl` is optional and used only to build clickable review URLs.
- Requires `gerrit_ssh_host`, `gerrit_ssh_port`, `gerrit_username`, `gerrit_ssh_key_path` from the resolved Gerrit integration.
- `pushDirect(repoDir, ref, topic)`: pushes HEAD to `refs/for/<branch>%topic=<topic>` via SSH. Returns a `VcsPushResult` with the Change-Id parsed from the commit footer.

### `gitlabVcsConnector.ts`
- Pushes via HTTPS using the project access token.
- Creates or updates a Merge Request via the REST API; reuses the same source branch when `existingChangeId` is set.
- The target GitLab project can come either from legacy integration config (`projectId`) or from the VE project push-target binding (`repoKey`) passed through `vcsFactory`.
- Returns the MR web URL.
- `pushDirect(repoDir, ref, topic)`: force-pushes the feature branch and creates (or finds existing) MR. `topic` parameter is ignored (GitLab doesn’t use Gerrit topics). Resets remote URL after push to avoid token leak.

### `githubVcsConnector.ts`
- HTTP-based clone and push for GitHub, mirroring the GitLab design: clones via HTTPS with the token in the remote URL, pushes a feature branch, and creates or updates a Pull Request via the GitHub REST API (`apiBaseUrl` supports both `api.github.com` and GHE `/api/v3`).
- `reviewSystemLabel = "github"`, `useChangeIdContinuity = false`.
- `buildPushSpec(baseBranch, taskId, ticketTitle)` derives the branch ref via `buildFeatureBranchRef` (no Gerrit topic).
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
3. Add unit tests; inject `RecordingGitRunner` from `tests/unit/helpers/recordingGitRunner.ts` and mock `src/workspace/dockerVolume.ts` as appropriate rather than running real Git or Docker operations.

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [plugins.md](plugins.md) — descriptor registry that produces VCS connectors via `source_control` capability
- [connectors.md](connectors.md) — review-side connectors that pair with VCS push
- [orchestrator.md](orchestrator.md) — caller of the required project-mode `pushDirect` path
