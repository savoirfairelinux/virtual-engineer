---
applyTo: "package.json,Dockerfile.agent,Dockerfile.orchestrator,vitest.config.ts,vite.admin.config.ts,tsconfig.json,tsconfig.agent.json,tsconfig.admin-ui.json,tsconfig.admin-ui-tests.json,eslint.config.js,drizzle.config.ts"
description: "Keep build/test/tooling docs in sync with project configuration."
---
# Keep tooling docs in sync

When editing root-level project configuration:

1. **`package.json` `scripts`** changed → update [.github/context/testing.md](../context/testing.md). Also update [.github/copilot-instructions.md](../copilot-instructions.md) when a **Quality Gates** command changes, or when a script named in its **Useful project commands** sentence is added, renamed, or removed.
2. New / removed dependency that affects architecture → mention it in the relevant `.github/context/*.md`.
3. **`Dockerfile.agent`** changed → if the rebuild instructions are still valid, leave the agent-image rebuild bullet under **Recent Gotchas** in [.github/copilot-instructions.md](../copilot-instructions.md) as-is; otherwise update it.
4. **`vitest.config.ts`** changed → update [.github/context/testing.md](../context/testing.md) (frameworks, gates, coverage).
5. Strictness flags changed in `tsconfig.json`, `tsconfig.agent.json`, `tsconfig.admin-ui.json`, or `tsconfig.admin-ui-tests.json` → update the **TypeScript Conventions** section in `copilot-instructions.md` and the strict-mode block in `skills/typescript-standard/SKILL.md`.
