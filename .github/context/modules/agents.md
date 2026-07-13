# Agents Module

## Container Environment

- Agent containers are built by `src/agents/copilotAdapter.ts` and `src/agents/claudeAdapter.ts`.
- `SKILL_DISCOVERY=1` enables local and global skill directories inside the worker.
- Project remote skill source configuration is not passed into the agent container. `SKILL_SOURCES_JSON`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, and private-key paths must stay outside the agent runtime.

## Remote Skills

- `src/workspace/workspaceRunner.ts` installs remote skills before starting the agent container.
- Installation runs in the `/ve-home` Docker volume through `execInVolume()` with `HOME=/workspace`, so global skills are visible to the later agent container at `/ve-home`.
- Skill source parsing and `npx skills` argument construction live in `src/workspace/skillSources.ts`.
- SSH skill sources use the short-lived helper install container only. The helper may use host `SSH_AUTH_SOCK` or a configured `sshKeyPath`, and `sshKnownHostsPath` enables strict host key checking. Credentials and SSH options are not mounted or exported into the agent container.

## Worker Skill Loading

- `agent-worker/src/providers/copilot.ts` loads local `<repo>/.github/skills` and Copilot global skills from `$HOME/.copilot/skills` when skill discovery is enabled.
- `agent-worker/src/skills.ts` only exposes global skill directory helpers. Remote skill fetching is intentionally host-side, not worker-side.
