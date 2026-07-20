# Agents Module

The `agent_execution` capability has three engines: **Copilot** (`copilotAdapter.ts`), **Claude Code** (`claudeAdapter.ts`), and **Mock** (`mockAgentAdapter.ts`). Both coding and review flows are supported by Copilot and Claude; review uses `REVIEW_MODE=1`.

## Container Environment

- Agent containers are built by `src/agents/copilotAdapter.ts` and `src/agents/claudeAdapter.ts`.
- `SKILL_DISCOVERY=1` enables local repository skills inside the worker.
- `LOCAL_SKILLS_PATH` is injected only when skill discovery is enabled. It is workspace-relative and defaults to `.github/skills`.
- Project remote skill source configuration is not passed into the agent container. `SKILL_SOURCES_JSON`, `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`, and private-key paths must stay outside the agent runtime.

## External Skills

- `src/workspace/workspaceRunner.ts` installs remote skills before starting the agent container.
- Installation runs in the `/ve-home` Docker volume through `execInVolume()` with `HOME=/workspace`, so global skills are visible to the later agent container at `/ve-home`.
- Skill source parsing and `npx skills` argument construction live in `src/workspace/skillSources.ts`.
- SSH skill sources use the short-lived helper install container only. The helper may use host `SSH_AUTH_SOCK` or a configured `sshKeyPath`, and `sshKnownHostsPath` enables strict host key checking. Credentials and SSH options are not mounted or exported into the agent container.

## Worker Skill Loading

- `agent-worker/src/providers/copilot.ts` loads the configured local skills directory only when skill discovery is enabled, and always loads Copilot global skills from `$HOME/.copilot/skills` when that fetched-skills directory exists.
- `agent-worker/src/providers/claude.ts` emits the same local-skill timeline event when skill discovery is enabled; Claude skill loading itself remains owned by Claude Code settings.
- `agent-worker/src/skills.ts` resolves the local skills path, keeps it inside the workspace, lists one directory name per local skill, and emits one `skills.local_loaded` event containing the configured path and sorted skill list.
- Remote skill fetching is intentionally host-side, not worker-side.

## Claude engine specifics

- `claudeAdapter.ts` injects `AGENT_PROVIDER=claude`, exactly one auth env var, and `CLAUDE_MODEL` **only when a model is configured** (no hardcoded default — the Claude CLI picks its own).
- Auth modes (descriptor `src/plugins/descriptors/claude.ts`): `api_key` → `ANTHROPIC_API_KEY`; `subscription` → `CLAUDE_CODE_OAUTH_TOKEN` (Claude Pro/Max, obtained via the auth-code + PKCE flow in `claudeOAuth.ts`, stored encrypted).
- The Claude runner (`agent-worker/src/providers/claude.ts`, selected by the worker's provider registry when `AGENT_PROVIDER=claude`) drives the Claude Agent SDK `query()` and maps its message stream onto the shared `__ve_event` / commit / `AgentResult` pipeline.
- Cost: Claude has no AIU, so `agent_cycles` USD/credit columns stay null; token usage is still emitted as `assistant.usage` events.
