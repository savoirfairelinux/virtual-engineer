# Module — Workspace

**Source:** [src/workspace/](../../../src/workspace/).

The workspace module currently owns Docker named-volume materialization for agent runs and the bounded, read-only discovery path used to preview multi-repository manifests before project configuration is changed.

## Manifest scan pipeline

1. A coding project's primary push target supplies an existing `integrationId`, `repoKey`, clone URL, and target revision.
2. `POST /api/admin/projects/scan-push-targets` calls `workspaceScanService.ts`, which resolves the provider descriptor and decrypts/preprocesses its config on the server. The lower-level `POST /api/admin/integrations/:id/workspace-scan` route uses the same service and remains available for integration-scoped previews.
3. `ProviderDescriptor.readWorkspaceManifestFiles` recursively inventories standard manifests down to four directories deep and dependency declarations down to eight, excluding generated trees. Credentials remain inside the provider transport.
4. `workspaceManifestScanner.ts` parses the returned files without network access or side effects.
5. The project route matches every URL-backed member against cached existing integrations. It follows only unique, enabled `gitlink` matches, up to three levels and 20 scanned repositories, so a root such as `jami-client-qt` can expose declarations inside its matched `daemon` submodule. Child failures become diagnostics; the root scan remains fail-closed.
6. The UI preview never adds a push target automatically. Each unique enabled match exposes an explicit add button; ambiguous, disabled, unmatched, and local-only observations remain preview-only. Detected members are searchable locally and displayed in a five-row scroll viewport. A newly added scanned member uses the first branch returned by provider discovery. If discovery is unavailable, a branch-like manifest revision is preferred, then the cached provider default and `main`; persisted target branches are never replaced by a partial refreshed listing. Saving remains the persistence boundary.

## Supported formats

| Format | Detection | Result |
|---|---|---|
| Git submodules | `.gitmodules` | `gitlink`; relative URLs resolve against the primary remote |
| west | `west.yml` | projects resolve through explicit URLs or named `url-base` remotes |
| Google repo | `manifest.xml`, `default.xml` | remote/default/project attributes become manifest members |
| vcstool | `*.repos` | Git entries become manifest members; non-Git entries are diagnostic-only |
| VS Code multi-root | `*.code-workspace` JSONC | URL-backed folders can resolve; ordinary local folders remain manual because the format has no Git remote identity |
| Vendored contrib packages | `contrib/**/package.json` | Static `name` / `url` / `version` entries infer GitHub or GitLab repository URLs from archive URLs |
| CMake FetchContent | `CMakeLists.txt` | Static `GIT_REPOSITORY` or inferable GitHub/GitLab archive `URL` declarations become members; variable-driven declarations remain diagnostic-only |

YAML uses `yaml`, XML uses `fast-xml-parser`, and VS Code JSONC uses `jsonc-parser`. Invalid files return error diagnostics and no partial repositories from that file.

## Provider transport

- **GitHub:** authenticated recursive Git Trees inventory plus Contents API base64 reads at the requested `ref`; truncated trees fail closed.
- **GitLab:** authenticated recursive repository-tree pagination plus raw-file reads at the requested `ref`.
- **Gerrit:** temporary bare object workflow (`git init`, shallow filtered fetch, recursive `ls-tree`, `git show`) using the integration's SSH identity and host-key policy. Temporary data is removed in `finally`.

All transports validate repository keys. Scans read at most 200 allowlisted declarative files per repository, each at most 256 KiB. Standard manifests are limited to four directory levels; contrib package and CMake declarations allow eight while excluding `.git`, build/cache/output directories, `_deps`, `node_modules`, and `cmake-build-*`. Every GitHub/GitLab listing and content request and every Gerrit command times out after 60 seconds; GitLab listing is also capped at 10 pages. Repository paths declared by a nested standard manifest are anchored under that manifest's directory (for example `contrib/workspace.repos` member `src/codec` becomes `contrib/src/codec`). Traversal segments are rejected. No lifecycle command, CMake code, workspace task, repo/west extension, `copyfile`, `linkfile`, `rules.mak`, or manifest script is executed.

## Current boundary

`project_push_targets` still combines workspace presence with write/push delivery. **Scan workspace** is read-only: a unique enabled match enters the unsaved push-target list only after the user clicks that detected member, and no server state changes until **Save**. A future canonical workspace snapshot will persist read-only context independently from delivery targets. Scanned paths are currently tracked only in React state, so persisted targets reload as legacy/manual entries until provenance metadata is added in the next phase.

## Related docs

- [INDEX.md](../INDEX.md)
- [plugins.md](plugins.md)
- [admin.md](admin.md)
- [architecture.md](../architecture.md)