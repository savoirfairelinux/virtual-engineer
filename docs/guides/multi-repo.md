# Multi-repo workspaces

Scan manifests and classify members.

A coding project can span several repositories. Scanning the primary target inventories its declarative manifests read-only, without executing any build code, and reports what it finds. Nothing is persisted until you add a member explicitly and save.

`git submodules` `west` `Google repo` `vcstool` `VS Code multi-root` `contrib packages` `CMake FetchContent` `kas (Yocto)` `BitBake recipes`

## Member classification

| Name | Description |
| --- | --- |
| `internal` | Lives inside the root repository. No separate push target. |
| `fork_pushable` | An enabled integration stands behind it, so VE can push to it. |
| `patch_required` | Upstream-only. Must be patched locally rather than pushed. |
| `ambiguous` | Matches several integrations. Needs a human decision before use. |

Members VE cannot push become tracked vendor components; members it owns become push targets.
