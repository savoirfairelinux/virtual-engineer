---
applyTo: "src/connectors/**,src/vcs/**,src/plugins/**"
description: "Keep connectors / VCS / plugins documentation in sync."
---
# Keep connector / VCS / plugin docs in sync

When editing files under `src/connectors/`, `src/vcs/`, or `src/plugins/`:

1. New connector → add it to [.github/context/modules/connectors.md](../context/modules/connectors.md) and to the **Source layout** in [.github/copilot-instructions.md](../copilot-instructions.md).
2. New VCS connector or change to `vcsFactory` → update [.github/context/modules/vcs.md](../context/modules/vcs.md).
3. New descriptor in `src/plugins/descriptors/` → list it in [.github/context/modules/plugins.md](../context/modules/plugins.md) and in the source-layout block of `copilot-instructions.md`.
4. If interface contracts (`TicketConnector`, `ReviewConnector`, `VcsConnector`) changed, update the corresponding **Contract** section.
5. If provider resolution rules changed (priority, duplicate handling, capability lookup), update the **Resolution rules** section in `modules/plugins.md` and the matching bullets in `copilot-instructions.md` and `architecture.md`.
