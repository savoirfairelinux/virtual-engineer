# Module — Workspace

**Source:** [src/workspace/](../../../src/workspace/).

The workspace module currently owns Docker named-volume materialization for agent runs and the bounded, read-only discovery path used to preview multi-repository manifests before project configuration is changed.

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
| Vendored contrib packages | `contrib/**/package.json` | Static `name` / `url` / `version` entries infer GitHub or GitLab repository URLs from archive URLs |
| CMake FetchContent | `CMakeLists.txt` | Static `GIT_REPOSITORY` or inferable GitHub/GitLab archive `URL` declarations become members; variable-driven declarations remain diagnostic-only |
| kas (Yocto) | any bounded candidate `*.yml` / `*.yaml`, confirmed by content | `repos` entries with a `url` become manifest members (`refspec`/`commit`/`branch` as revision, `path` or the entry key as local path); URL-less entries are layers living inside the root repository and become `contains` members with a null clone URL |
| BitBake recipes | `*.bb` / `*.bbappend` / `*.inc` under a `meta` / `meta-*` directory | static `git://` / `gitsm://` `SRC_URI` fetchers become manifest members under a synthetic `.ve-deps/<repository>` local path. `.inc` files are scanned because recipes routinely `require` them and keep the `SRC_URI` there |

kas configurations have no conventional filename, so candidates are name-prefiltered (`kas` / `repo` / `config` / `manifest` / `project` stems, or any file under a `kas/` directory) at most two directories deep, then confirmed from content: a `repos` mapping whose entries are all mappings, or an explicit `header`. Files that fail the content check are skipped silently and never produce diagnostics, because unrelated YAML is expected in the candidate set. kas `path` values are build-root-relative and are therefore not re-anchored under the manifest's directory.

Recipes are parsed only when a kas configuration in the same repository declared at least one URL-less (internal) layer — without a layer VE owns, an upstream `SRC_URI` is not actionable. Any `*SRC_URI` assignment is read (covering class aliases such as `PYPI_SRC_URI`), line continuations are joined, and values are expanded against same-file assignments plus the `PN` / `BPN` / `PV` derived from the recipe filename **before** the fetcher is split, so a URL held in a variable (`SRC_URI = "${MY_LIB_SRC};branch=…"`) still contributes its own parameters. Entries that still contain `${…}` after expansion are skipped, matching the static-only rule already used for CMake `FetchContent`. The `protocol=` parameter selects the emitted clone URL scheme; the revision is `tag`, then a same-file `SRCREV`, then `branch`, with `AUTOINC` treated as no revision. Duplicate clone URLs within one recipe are collapsed. Measured against ~2,800 upstream recipes (poky, meta-openembedded, meta-freescale, meta-raspberrypi), this resolves 99.5% of recipes carrying a git fetcher.

YAML uses `yaml`, XML uses `fast-xml-parser`, and VS Code JSONC uses `jsonc-parser`. Invalid files return error diagnostics and no partial repositories from that file.

## Provider transport

- **GitHub:** authenticated recursive Git Trees inventory plus Contents API base64 reads at the requested `ref`; truncated trees fail closed.
- **GitLab:** authenticated recursive repository-tree pagination plus raw-file reads at the requested `ref`.
- **Gerrit:** temporary bare object workflow (`git init`, shallow filtered fetch, recursive `ls-tree`, `git show`) using the integration's SSH identity and host-key policy. Temporary data is removed in `finally`.

All transports validate repository keys. Scans read at most 200 allowlisted declarative files per repository, each at most 256 KiB, with at most eight concurrent GitHub/GitLab content reads. kas candidates are budgeted **separately** from that allowlist: at most 25 candidate YAML files are read, and overflow truncates the candidate list instead of failing the scan, so unrelated YAML (Helm values, CI definitions, compose files) can never consume the manifest budget or turn a previously working scan into an error. BitBake recipes get a third separate budget of at most 200 files, are read **only when the same listing also exposes a kas candidate**, and likewise truncate rather than fail. Because only the root repository and matched enabled submodules are ever listed, upstream layers such as poky or meta-openembedded — which are separate repositories — are never traversed. Standard manifests are limited to four directory levels; contrib package and CMake declarations allow eight, recipes six, while excluding `.git`, build/cache/output directories, `_deps`, `node_modules`, and `cmake-build-*`. Every GitHub/GitLab listing and content request and every Gerrit command times out after 60 seconds; GitLab listing is also capped at 10 pages. VS Code URI members and resolved `.gitmodules` URLs expose only HTTP(S), SSH, Git, or SCP-style repository identities; explicit local or unsupported schemes remain local-only or diagnostic. Repository paths declared by a nested standard manifest are anchored under that manifest's directory (for example `contrib/workspace.repos` member `src/codec` becomes `contrib/src/codec`). Traversal segments are rejected. No lifecycle command, CMake code, workspace task, repo/west extension, `copyfile`, `linkfile`, `rules.mak`, or manifest script is executed.

## Push-capability classification

Every member returned by the project-level scan carries an `origin` derived by `classifyRepositoryOrigin(cloneUrl, resolution)`:

| `origin` | Meaning | Derivation |
|---|---|---|
| `internal` | Lives inside the root repository; directly editable | `cloneUrl === null` |
| `fork_pushable` | VE owns an enabled integration for it and can push | resolution `matched` **and** `match.enabled` |
| `patch_required` | Upstream-only; must be patched locally instead of pushed | any other resolved/unresolved URL-backed member |
| `ambiguous` | Several integrations match; a human must disambiguate | resolution `ambiguous` |

Operators can persist selected members as **vendor components** (`project_vendor_components`), keyed by the member's real `sourcePath` (for example `daemon/contrib/src/fmt/package.json`) rather than its possibly synthetic `localPath` (`.ve-deps/fmt`), together with a free-form note describing how the component should be handled. A component that one of our repositories actually owns is not tracked here — it becomes a push target instead, so the agent edits and pushes it.

## Current boundary

`project_push_targets` still combines workspace presence with write/push delivery. **Scan workspace** is read-only: a unique enabled match enters the unsaved push-target list only after the user clicks that detected member, and no server state changes until **Save**. A future canonical workspace snapshot will persist read-only context independently from delivery targets. Scanned paths are currently tracked only in React state, so persisted targets reload as legacy/manual entries until provenance metadata is added in the next phase.

## Related docs

- [INDEX.md](../INDEX.md)
- [plugins.md](plugins.md)
- [admin.md](admin.md)
- [architecture.md](../architecture.md)