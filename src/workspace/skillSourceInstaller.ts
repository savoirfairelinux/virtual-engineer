/**
 * Host-side installer for project-configured external skill sources.
 *
 * Runs entirely on the orchestrator host, before the workspace directory is
 * uploaded to the OpenShell sandbox: the `skills` CLI resolves and fetches each
 * configured source (over SSH using host-local key paths, exactly like
 * `HostGitExecutor` and `src/admin/skillSourceDiscovery.ts` already do) and
 * copies the selected skill(s) into the workspace tree at the target agent's
 * project-scope path (e.g. `.claude/skills/`). Because the install runs before
 * upload, the resulting skill files ride along with the ordinary workspace
 * upload — no SSH material, `GIT_SSH_COMMAND`, or `SKILL_SOURCES_JSON` ever
 * reaches the sandbox.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildSkillsCliArgs,
  buildSkillSourceSubprocessEnv,
  parseRemoteSkillSources,
  skillsAgentId,
  type AgentProvider,
  type RemoteSkillSource,
} from "./skillSources.js";
import { readSshFileSecure } from "../utils/sshFilePath.js";
import { getLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const log = getLogger("skill-source-installer");

export const SKILL_INSTALL_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_BUFFER = 1024 * 1024;

/** Project-scope directory each `skills` CLI agent id installs into, relative to cwd. */
const PROJECT_SKILL_DIR: Readonly<Record<string, string>> = {
  "github-copilot": ".agents/skills/",
  "claude-code": ".claude/skills/",
  goose: ".goose/skills/",
  // Best-guess convention, unconfirmed against a live Codex CLI — verify
  // before relying on this in production (see agents.md "Codex engine specifics").
  codex: ".codex/skills/",
};

function assertSshPathsReadable(source: RemoteSkillSource): void {
  if (source.sshKeyPath) readSshFileSecure(source.sshKeyPath, "SSH private key");
  if (source.sshKnownHostsPath) readSshFileSecure(source.sshKnownHostsPath, "SSH known_hosts");
}

/** `skills add` (project scope) writes/updates a `skills-lock.json` manifest at the
 * workspace root, tracked or not. Snapshot it before installing and restore it
 * after so the agent never sees it as a new/modified file to accidentally commit. */
async function readLockFileSnapshot(lockFilePath: string): Promise<Buffer | null> {
  try {
    return await readFile(lockFilePath);
  } catch {
    return null;
  }
}

async function restoreLockFileSnapshot(lockFilePath: string, snapshot: Buffer | null): Promise<void> {
  if (snapshot !== null) {
    await writeFile(lockFilePath, snapshot);
  } else {
    await rm(lockFilePath, { force: true });
  }
}

/** Adds `relDir` to `.git/info/exclude` (local-only, never committed) so the agent's own
 * git commands never see or stage the staged skill directory. No-op for multi-repo
 * project layouts where the workspace root itself isn't a git repository. */
async function excludeFromGitStatus(workspaceDir: string, relDir: string): Promise<void> {
  const gitDir = join(workspaceDir, ".git");
  if (!existsSync(gitDir)) return;
  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");
  const entry = relDir.endsWith("/") ? relDir : `${relDir}/`;
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  if (existing.split("\n").some((line) => line.trim() === entry)) return;
  await mkdir(infoDir, { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}${entry}\n`, "utf8");
}

/**
 * Installs every configured skill source into `workspaceDir` for `provider`, before
 * the workspace is uploaded to the sandbox. Best-effort per source: a single source
 * failing (auth, network, malformed repo) is logged and skipped, never fatal to the
 * agent cycle. No-op when no sources are configured or `provider` has no upstream
 * skill-directory convention (e.g. Aider, Mock).
 */
export async function installSkillSources(
  workspaceDir: string,
  skillSourcesJson: string | undefined,
  provider: AgentProvider | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!skillSourcesJson || skillSourcesJson === "[]") return;
  if (provider === undefined) {
    log.debug({ workspaceDir }, "skill sources configured but the selected agent has no skill-directory support; skipping");
    return;
  }

  let sources: RemoteSkillSource[];
  try {
    sources = parseRemoteSkillSources(skillSourcesJson);
  } catch (err) {
    log.warn({ err }, "invalid skillSourcesJson; skipping skill installation");
    return;
  }
  if (sources.length === 0) return;

  const agentId = skillsAgentId(provider);
  const lockFilePath = join(workspaceDir, "skills-lock.json");
  const lockSnapshot = await readLockFileSnapshot(lockFilePath);
  try {
    for (const [index, source] of sources.entries()) {
      if (signal?.aborted) break;
      try {
        assertSshPathsReadable(source);
        await execFileAsync("npx", buildSkillsCliArgs(source, provider), {
          cwd: workspaceDir,
          env: buildSkillSourceSubprocessEnv(source),
          encoding: "utf8",
          maxBuffer: OUTPUT_MAX_BUFFER,
          timeout: SKILL_INSTALL_TIMEOUT_MS,
          signal,
        });
        log.info({ source: source.source, agentId }, "installed skill source");
      } catch (err) {
        if (signal?.aborted) {
          log.warn({ source: source.source, index, agentId }, "skill source install aborted; stopping further installs");
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ source: source.source, index, agentId, err: message }, "skill source install failed; continuing without it");
      }
    }
  } finally {
    try {
      await restoreLockFileSnapshot(lockFilePath, lockSnapshot);
    } catch (err) {
      log.warn({ err }, "failed to restore pre-install skills-lock.json state");
    }
  }

  const projectSkillDir = PROJECT_SKILL_DIR[agentId];
  if (!projectSkillDir) return;
  try {
    await excludeFromGitStatus(workspaceDir, projectSkillDir);
  } catch (err) {
    log.warn({ err }, "failed to exclude staged skill directory from git status");
  }
}
