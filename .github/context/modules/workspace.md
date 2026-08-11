# Module — Workspace

**Source:** [src/workspace/](../../../src/workspace/).

The workspace module owns two unrelated concerns: (a) the **agent runtime** — host-side Git plumbing plus the OpenShell sandbox lifecycle — and (b) the bounded, read-only discovery path used to preview multi-repository manifests before project configuration is changed. `integrationBindingResolver.ts` implements the repository-URL-to-integration matching used by `POST /api/admin/projects/resolve-repositories` (normalized by host, optional port, and path) so a scanned manifest member can be linked back to an existing enabled integration.

## Agent runtime

`openShellWorkspaceRunner.ts` is the **sole** `WorkspaceRunner`. There is no `DockerWorkspaceRunner`, no `dockerVolume.ts`, no `execInVolume()`, and no `ve-ws-*` / `ve-home-*` named volumes.

| File | Role |
|---|---|
| `hostGitExecutor.ts` | All host-side Git plumbing: `createWorkspace`, `cloneRepo`, `fetchAndCheckout`, `fetchAndCherryPick`, `execGit`, `rebuildTrustedMetadata`, `destroyWorkspace`, `credentialFreeUrl`. Every `execFile` goes through `trustedGitArgs` / `trustedGitEnv` (`src/utils/gitExec.ts`). |
| `openShellWorkspaceRunner.ts` | Sandbox lifecycle: create → upload → exec → download → destroy. |
| `agentWorkerProtocol.ts` | Validates the worker's JSON result envelope at the workspace boundary (`decodeReviewWorkerOutput`). |
| `skillSources.ts` | Parses `projects.skill_sources_json`, builds `npx skills` arguments (project-scoped), and exports the shared SSH/env-building helpers reused by both admin-side discovery and the host-side installer. |
| `skillSourceInstaller.ts` | Host-side `installSkillSources()`: fetches each configured skill source and installs it into the workspace directory **before** upload — see below. |

### Sandbox lifecycle (per cycle)

1. `createWorkspace()` — `HostGitExecutor.createWorkspace()` makes a host scratch dir under `WORKSPACE_BASE_DIR`; the sandbox name is `ve-<taskId>-<8 hex>`; the handle's `containerId` is `openshell:<sandboxName>`.
2. `prepareProjectWorkspace()` / `cloneRepo()` — clones each push target **on the host** (ordered by `commitOrder`; secondary-target failures are non-fatal) and records a credential-free remote per local path in `trustedRemotes`.
3. `runAgentInDocker()` (name retained for compatibility) — resolves the policy (`resolvePolicy` → `runtimePolicyResolver`, falling back to `buildDefaultPolicyYaml()`), splits credential env vars into a temporary OpenShell provider (`splitManagedProviderEnv`, recorded in `managed_openshell_providers` **before** remote creation), creates the sandbox with ownership labels, calls `allowEgress` for the adapter's `AgentEgressSpec`, calls `installSkillSources()` (see below) to stage any configured skill sources into the host workspace dir, uploads the workspace to `/sandbox` with `noGitIgnore: true`, runs the optional post-clone script **inside** the sandbox, then execs `spec.command` with `workdir = /sandbox/<basename(dir)>`.
4. Download — the coding flow downloads the sandbox repo path back onto the host dir, then `restoreTrustedRemotes()` rebuilds `.git` config/hooks/attributes/alternates from the recorded host-trusted remotes. `runReviewInDocker()` uploads only; nothing is downloaded back.
5. `destroyWorkspace()` — removes the sandbox, then the temporary provider, clears the ledger row, and finally deletes the host directory.

Additional invariants:

- `listTrustedRepoPaths(handle)` returns only sub-paths VE itself cloned. `Orchestrator.pushProjectChanges()` refuses to run git anywhere else, so an agent-authored directory never receives push credentials.
- Sandbox paths: `/sandbox` (writable workspace root), `/tmp/user-prompt.txt` (`USER_PROMPT_FILE`), `/app/agent-worker/` (worker runtime, read-only). `/workspace` and `/ve-home` do not exist.
- `collectPolicyDenials()` runs in a `finally` after every attempt: bounded `getSandboxLogs({ lines: 200, since: "75m" })` with a 30 s abort, parsed by `parseDenialEvent` (`src/openshell/denialEvents.ts`), deduplicated per sandbox by a fingerprint cache capped at 1 000 raw lines, and persisted through the injected `recordDenial` sink. There is no `denyEventPoller.ts`, no `pollDenials()`, and no `DenialSource`.
- `execTimeoutSec` (from `AGENT_TIMEOUT_MS`) is passed to `sandbox exec --timeout`.

### External skill sources

`projects.skill_sources_json` is persisted, editable in the admin UI, and forwarded onto `AgentSession.skillSourcesJson` / `ReviewWorkspaceInput.skillSourcesJson`. `OpenShellWorkspaceRunner` calls `skillSourceInstaller.ts`'s `installSkillSources(workspaceDir, skillSourcesJson, provider)` **on the host**, after clone/checkout/cherry-pick is finalized and before `uploadToSandbox` — so the resulting skill files ride along with the ordinary workspace upload and no SSH material, `GIT_SSH_COMMAND`, or `SKILL_SOURCES_JSON` ever reaches the sandbox. Each source is fetched with `npx skills add` in **project scope** (no `-g`), writing into the target agent's project-relative skill directory (`.claude/skills/` for Claude, `.agents/skills/` for Copilot, `.goose/skills/` for Goose — Aider and Mock have no such convention and are skipped). When the workspace root is a single git repo, the staged directory is appended to `.git/info/exclude` (local-only, never committed) so the agent's own `git status`/`git add -A` never sees or stages it; multi-repo project layouts need no such exclusion since the staged directory sits outside every sub-repo's tree. A single source's failure (auth, network, malformed repo) is logged and skipped — never fatal to the agent cycle.

## Manifest scan pipeline

1. A coding project's primary push target supplies an existing `integrationId`, `repoKey`, clone URL, and target revision.
2. `POST /api/admin/projects/scan-push-targets` calls `workspaceScanService.ts`, which resolves the provider descriptor and decrypts/preprocesses its config on the server. The lower-level `POST /api/admin/integrations/:id/workspace-scan` route uses the same service and remains available for integration-scoped previews.
3. `ProviderDescriptor.readWorkspaceManifestFiles` recursively inventories standard manifests down to four directories deep and dependency declarations down to eight, excluding generated trees. Credentials remain inside the provider transport.
4. `workspaceManifestScanner.ts` parses the returned files without network access or side effects.
5. The project route matches every URL-backed member against cached existing integrations. It follows only unique, enabled `gitlink` matches, up to three levels and 20 scanned `(integration, repository, revision)` identities, so the same repository can be inspected at two declared revisions without reusing the wrong manifests. A root such as `jami-client-qt` can expose declarations inside its matched `daemon` submodule. Child failures become diagnostics; the root scan remains fail-closed.
6. The UI preview never adds a push target automatically. Each unique enabled match exposes an explicit add button; ambiguous, disabled, unmatched, and local-only observations remain preview-only. Detected members are searchable locally and displayed in a five-row scroll viewport. Scan results, search state, and errors are keyed by root clone URL so changing one target cannot surface another target's failure. A newly added scanned member uses the first branch returned by provider discovery. If discovery is unavailable, a branch-like manifest revision is preferred, then the cached provider default and `main`; persisted target branches are never replaced by a partial refreshed listing. Saving remains the persistence boundary.

## Supported formats

| Format | Detection | Result |
|---|---|---|
| Git submodules | `.gitmodules` | `gitlink`; relative URLs resolve against the primary remote |
| west | `west.yml` | projects resolve through explicit URLs or named `url-base` remotes |
| Google repo | `manifest.xml`, `default.xml` | remote/default/project attributes become manifest members |
| vcstool | `*.repos` | Git entries become manifest members; non-Git entries are diagnostic-only |
| VS Code multi-root | `*.code-workspace` JSONC | HTTP(S), SSH, Git, and SCP-style Git URIs can resolve; local and unsupported URI schemes remain manual and never become clone URLs |
| Vendored contrib packages | `contrib/**/package.json` | Static `name` / `url` / `version` entries infer GitHub or GitLab repository URLs from archive URLs; members are `fetched` |
| CMake FetchContent | `CMakeLists.txt` | Static `GIT_REPOSITORY` or inferable GitHub/GitLab archive `URL` declarations become `fetched` members; variable-driven declarations remain diagnostic-only |
| kas (Yocto) | any bounded candidate `*.yml` / `*.yaml`, confirmed by content | `repos` entries with a `url` become manifest members (`refspec`/`commit`/`branch` as revision, `path` or the entry key as local path); URL-less entries are layers living inside the root repository and become `contains` members with a null clone URL |
| BitBake recipes | `*.bb` / `*.bbappend` / `*.inc` under a `meta` / `meta-*` directory | static `git://` / `gitsm://` `SRC_URI` fetchers become members with relation `fetched` and the repository name as `localPath`. `.inc` files are scanned because recipes routinely `require` them and keep the `SRC_URI` there |

A `fetched` member is downloaded by the build (a contrib tarball, a CMake `FetchContent`, a BitBake `SRC_URI`) and is checked out nowhere in the source tree, so its `localPath` is only the repository name. The admin form treats that name as a suggestion and picks a free checkout directory when the member is added as a push target, instead of pinning it to a directory that does not exist.

kas configurations have no conventional filename, so candidates are name-prefiltered (`kas` / `repo` / `config` / `manifest` / `project` stems, or any file under a `kas/` directory) at most two directories deep, then confirmed from content: a `repos` mapping whose entries are all mappings or empty. A `header` block is typical of kas but is never sufficient on its own, since a scalar-valued `repos` entry would otherwise be read as a layer internal to the repository and would unlock recipe scanning. Files that fail the content check are skipped silently and never produce diagnostics, because unrelated YAML is expected in the candidate set. kas `path` values are build-root-relative and are therefore not re-anchored under the manifest's directory.

Recipes are parsed only when a kas configuration in the same repository declared at least one URL-less (internal) layer — without a layer VE owns, an upstream `SRC_URI` is not actionable. Any `*SRC_URI` assignment is read (covering class aliases such as `PYPI_SRC_URI`), line continuations are joined, and values are expanded against same-file assignments plus the `PN` / `BPN` / `PV` derived from the recipe filename **before** the fetcher is split, so a URL held in a variable (`SRC_URI = "${MY_LIB_SRC};branch=…"`) still contributes its own parameters. Entries that still contain `${…}` after expansion are skipped, matching the static-only rule already used for CMake `FetchContent`. The `protocol=` parameter selects the emitted clone URL scheme; the revision is `tag`, then a same-file `SRCREV`, then `branch`, with `AUTOINC` treated as no revision. Duplicate clone URLs within one recipe are collapsed. Measured against ~2,800 upstream recipes (poky, meta-openembedded, meta-freescale, meta-raspberrypi), this resolves 99.5% of recipes carrying a git fetcher.

YAML uses `yaml`, XML uses `fast-xml-parser`, and VS Code JSONC uses `jsonc-parser`. Invalid files return error diagnostics and no partial repositories from that file.

## Provider transport

- **GitHub:** authenticated recursive Git Trees inventory plus Contents API base64 reads at the requested `ref`; truncated trees fail closed.
- **GitLab:** authenticated recursive repository-tree pagination plus raw-file reads at the requested `ref`.
- **Gerrit:** temporary bare object workflow (`git init`, shallow filtered fetch, recursive `ls-tree`, `git show`) using the integration's SSH identity and host-key policy. Temporary data is removed in `finally`.

All transports validate repository keys. Scans read at most 200 allowlisted declarative files per repository, each at most 256 KiB, with at most eight concurrent GitHub/GitLab content reads. kas candidates are budgeted **separately** from that allowlist, both when candidate paths are selected and when the scanner consumes them: at most 25 candidate YAML files are read, and overflow truncates the candidate list instead of failing the scan, so unrelated YAML (Helm values, CI definitions, compose files) can never consume the manifest budget, turn a previously working scan into an error, or starve the kas configuration that gates recipe scanning. BitBake recipes get a third separate budget of at most 200 files, are read **only when the same listing also exposes a kas candidate**, and likewise truncate rather than fail. Because only the root repository and matched enabled submodules are ever listed, upstream layers such as poky or meta-openembedded — which are separate repositories — are never traversed. Standard manifests are limited to four directory levels; contrib package and CMake declarations allow eight, recipes six, while excluding `.git`, build/cache/output directories, `_deps`, `node_modules`, and `cmake-build-*`. Every GitHub/GitLab listing and content request and every Gerrit command times out after 60 seconds; GitLab listing is also capped at 10 pages. VS Code URI members and resolved `.gitmodules` URLs expose only HTTP(S), SSH, Git, or SCP-style repository identities; explicit local or unsupported schemes remain local-only or diagnostic. Repository paths declared by a nested standard manifest are anchored under that manifest's directory (for example `contrib/workspace.repos` member `src/codec` becomes `contrib/src/codec`). Traversal segments are rejected. No lifecycle command, CMake code, workspace task, repo/west extension, `copyfile`, `linkfile`, `rules.mak`, or manifest script is executed.

## Push-capability classification

Every member returned by the project-level scan carries an `origin` derived by `classifyRepositoryOrigin(cloneUrl, resolution)`:

| `origin` | Meaning | Derivation |
|---|---|---|
| `internal` | Lives inside the root repository; directly editable | `cloneUrl === null` |
| `fork_pushable` | VE owns an enabled integration for it and can push | resolution `matched` **and** `match.enabled` |
| `patch_required` | Upstream-only; must be patched locally instead of pushed | any other resolved/unresolved URL-backed member |
| `ambiguous` | Several integrations match; a human must disambiguate | resolution `ambiguous` |

Operators can persist selected members as **vendor components** (`project_vendor_components`), identified by the pair `(sourcePath, localPath)` — one manifest routinely declares several components, so the declaring path alone is not an identity. `sourcePath` is the member's real manifest path (for example `daemon/contrib/src/fmt/package.json`), while `localPath` for a `fetched` member is only the repository name because the dependency is downloaded at build time and exists nowhere in the source tree. Tracking takes no further configuration: the entry alone tells the agent to patch the component in place. A component that one of our repositories actually owns is not tracked here — it becomes a push target instead, so the agent edits and pushes it.

## Current boundary

`project_push_targets` still combines workspace presence with write/push delivery. **Scan workspace** is read-only: a unique enabled match enters the unsaved push-target list only after the user clicks that detected member, and no server state changes until **Save**. A future canonical workspace snapshot will persist read-only context independently from delivery targets. Scanned paths are currently tracked only in React state, so persisted targets reload as legacy/manual entries until provenance metadata is added in the next phase.

## Related docs

- [INDEX.md](../INDEX.md)
- [plugins.md](plugins.md)
- [admin.md](admin.md)
- [architecture.md](../architecture.md)