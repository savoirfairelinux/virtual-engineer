---
applyTo: "package.json,Dockerfile.agent,Dockerfile.orchestrator,vitest.config.ts,vite.admin.config.ts,tsconfig.json,tsconfig.agent.json,tsconfig.admin-ui.json,eslint.config.js,drizzle.config.ts"
description: "Keep build/test/tooling docs in sync with project configuration."
---
# Keep tooling docs in sync

When editing root-level project configuration:

1. **`package.json` `scripts`** changed → update the **Build & Test** block in [.github/copilot-instructions.md](../copilot-instructions.md) (and the helper-scripts list).
2. New / removed dependency that affects architecture → mention it in the relevant `.github/context/*.md`.
3. **`Dockerfile.agent`** changed → if the rebuild instructions are still valid, leave the existing **Container image rebuild** gotcha as-is; otherwise update it.
4. **`vitest.config.ts`** changed → update [.github/context/testing.md](../context/testing.md) (frameworks, gates, coverage).
5. **`tsconfig.json`** strictness flags changed → update the **TypeScript / Lint Conventions** in `copilot-instructions.md` and the strict-mode block in `skills/typescript-standard/SKILL.md`.
