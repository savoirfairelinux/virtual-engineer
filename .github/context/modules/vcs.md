# Modules — VCS

**Source:** [src/vcs/](../../../src/vcs/).

The VCS layer is host-owned. The agent container may edit files and create local commits, but the host still controls the final push and keeps review-system credentials outside the container.

## Interface — `vcsConnector.ts`

```ts
interface VcsConnector {
  commitAndPush(opts: {
    workspacePath: string;
    branch: string;
    commitMessage: string;     // includes Change-Id footer for Gerrit
    authorName: string;
    authorEmail: string;
    existingChangeId?: string; // when retrying a cycle
  }): Promise<{ changeRef: string; reviewUrl: string }>;

  /** Push agent-created commits directly (no host commit step). Optional. */
  pushDirect?(
    repoDir: string,
    ref: string,       // e.g. "refs/for/main" (Gerrit) or "feature-<taskId>" (GitLab)
    topic?: string     // Gerrit topic grouping, ignored by GitLab
  ): Promise<VcsPushResult>;
  // VcsPushResult = { changeId: string; url: string; status: string }
}
```

`changeRef` is the Gerrit Change-Id or GitLab MR IID; the orchestrator stores it in `tasks.gerrit_change_id` (legacy column name; same field for both providers) and the URL in `tasks.review_url`.

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
- Used by `src/index.ts` and refreshed through `refreshRuntimeDependencies()`.

## Tests

- `tests/unit/vcsConnector.test.ts`
- `tests/unit/vcsFactory.test.ts`
- `tests/unit/gerritVcsConnector.test.ts`
- `tests/unit/gitlabVcsConnector.test.ts`
- `tests/unit/githubVcsConnector.test.ts`
- `tests/unit/branchNaming.test.ts`

## Adding a new VCS

1. Implement `VcsConnector` in a new file under `src/vcs/`.
2. Add `capabilities.source_control.createVcsConnector(config, integration, context?) → VcsConnector` to the integration's descriptor (e.g. `src/plugins/descriptors/<name>.ts`). `vcsFactory` will pick it up automatically.
3. Add unit tests; mock `simple-git` rather than running real git commands.

## Related docs

- [INDEX.md](../INDEX.md) — navigable context index
- [architecture.md](../architecture.md) — layered architecture and data flow
- [plugins.md](plugins.md) — descriptor registry that produces VCS connectors via `source_control` capability
- [connectors.md](connectors.md) — review-side connectors that pair with VCS push
- [orchestrator.md](orchestrator.md) — caller of `commitAndPush` / `pushDirect`
