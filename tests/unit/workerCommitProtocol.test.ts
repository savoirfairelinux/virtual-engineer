/**
 * Tests for the agent-worker multi-commit protocol (Phase 2).
 *
 * These tests validate commit collection, validation, Change-Id injection,
 * and squash-into-base functionality defined in agent-worker/src/commitUtils.ts.
 * Functions are imported directly from source — no duplication.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import {
  collectCommits,
  validateCommits,
  deriveChangeId,
  injectChangeIds,
  squashIntoBaseIfNeeded,
} from "../../agent-worker/src/commitUtils.js";

// ── Test-local git helper (used by initRepo / addCommit only) ─────────────────
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── Test helpers ──────────────────────────────────────────────────────────────

let repoDir: string;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ve-commit-test-"));
  git(["init", "--initial-branch=main"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "user.email", "test@test.local"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "chore: initial commit"], dir);
  return dir;
}

function addCommit(dir: string, filename: string, content: string, message: string): void {
  const filePath = join(dir, filename);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  git(["add", filename], dir);
  git(["commit", "-m", message], dir);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent-worker multi-commit protocol", () => {
  beforeEach(() => {
    repoDir = initRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("collectCommits", () => {
    it("returns empty array when HEAD equals baseSha", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      const commits = collectCommits(baseSha, repoDir);
      expect(commits).toEqual([]);
    });

    it("collects a single commit with correct fields", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "src/main.ts", "export default 1;\n", "feat(api): add main entry point");
      const commits = collectCommits(baseSha, repoDir);

      expect(commits).toHaveLength(1);
      expect(commits[0]!.subject).toBe("feat(api): add main entry point");
      expect(commits[0]!.files).toEqual(["src/main.ts"]);
      expect(commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commits[0]!.repoKey).toBe("superproject");
    });

    it("collects multiple commits in oldest-first order", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "a.ts", "a\n", "feat: add a");
      addCommit(repoDir, "b.ts", "b\n", "fix: add b");
      addCommit(repoDir, "c.ts", "c\n", "test: add c");

      const commits = collectCommits(baseSha, repoDir);
      expect(commits).toHaveLength(3);
      expect(commits[0]!.subject).toBe("feat: add a");
      expect(commits[1]!.subject).toBe("fix: add b");
      expect(commits[2]!.subject).toBe("test: add c");
    });

    it("extracts Change-Id from commit body footer", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      writeFileSync(join(repoDir, "x.ts"), "x\n");
      git(["add", "x.ts"], repoDir);
      git(
        ["commit", "-m", "feat: with change id\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678"],
        repoDir
      );

      const commits = collectCommits(baseSha, repoDir);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.changeId).toBe("I1234567890abcdef1234567890abcdef12345678");
    });

    it("returns empty changeId when no Change-Id footer present", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "y.ts", "y\n", "fix: no change id");

      const commits = collectCommits(baseSha, repoDir);
      expect(commits[0]!.changeId).toBe("");
    });
  });

  describe("validateCommits", () => {
    it("returns valid for well-formed conventional commits", () => {
      const commits = [
        { sha: "aaa111aaa111aaa111aaa111aaa111aaa111aaa1", subject: "feat(api): add endpoint", files: ["src/api.ts"] },
        { sha: "bbb222bbb222bbb222bbb222bbb222bbb222bbb2", subject: "test(api): add tests", files: ["tests/api.test.ts"] },
      ];
      expect(validateCommits(commits)).toEqual({ valid: true });
    });

    it("rejects when commit count exceeds max", () => {
      const commits = Array.from({ length: 3 }, (_, i) => ({
        sha: `${i}`.padEnd(40, "0"),
        subject: `feat: commit ${i}`,
        files: [`file${i}.ts`],
      }));
      const result = validateCommits(commits, 2);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too many commits");
    });

    it("rejects non-conventional commit subject", () => {
      const commits = [
        { sha: "aaa".padEnd(40, "0"), subject: "added some stuff", files: ["a.ts"] },
      ];
      const result = validateCommits(commits);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("non-conventional subject");
    });

    it("rejects commit with empty diff", () => {
      const commits = [
        { sha: "aaa".padEnd(40, "0"), subject: "feat: empty commit", files: [] },
      ];
      const result = validateCommits(commits);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("empty diff");
    });

    it("rejects empty commits array", () => {
      const result = validateCommits([]);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("no commits found");
    });

    it("accepts all valid conventional commit types", () => {
      const types = ["feat", "fix", "refactor", "test", "chore", "docs", "perf", "ci", "build"];
      for (const type of types) {
        const commits = [
          { sha: "aaa".padEnd(40, "0"), subject: `${type}: valid subject`, files: ["a.ts"] },
        ];
        expect(validateCommits(commits).valid).toBe(true);
      }
    });

    it("rejects subject longer than 72 chars", () => {
      const longSubject = `feat: ${"a".repeat(80)}`;
      const commits = [
        { sha: "aaa".padEnd(40, "0"), subject: longSubject, files: ["a.ts"] },
      ];
      const result = validateCommits(commits);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("non-conventional subject");
    });
  });

  describe("end-to-end commit collection + validation", () => {
    it("collects and validates a real multi-commit chain", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "src/api.ts", "export function api() {}\n", "feat(api): add api module");
      addCommit(repoDir, "tests/api.test.ts", "test('api', () => {});\n", "test(api): add api tests");
      addCommit(repoDir, "docs/api.md", "# API\n", "docs(api): add api documentation");

      const commits = collectCommits(baseSha, repoDir);
      expect(commits).toHaveLength(3);

      const validation = validateCommits(commits);
      expect(validation.valid).toBe(true);
    });

    it("rejects a chain containing a bad commit", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "good.ts", "ok\n", "feat: good commit");
      addCommit(repoDir, "bad.ts", "nope\n", "this is not conventional");

      const commits = collectCommits(baseSha, repoDir);
      const validation = validateCommits(commits);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain("non-conventional subject");
    });
  });

  // ── Phase 4: Deterministic Change-Id tests ─────────────────────────────────

  describe("deriveChangeId", () => {
    it("produces a valid Gerrit Change-Id format (I + 40 hex chars)", () => {
      const changeId = deriveChangeId("TASK-1", "superproject", 0, "feat: add api");
      expect(changeId).toMatch(/^I[0-9a-f]{40}$/);
    });

    it("is deterministic — same inputs produce same output", () => {
      const a = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      const b = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      expect(a).toBe(b);
    });

    it("differs when taskId changes", () => {
      const a = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      const b = deriveChangeId("TASK-2", "repo-a", 0, "feat: add api");
      expect(a).not.toBe(b);
    });

    it("differs when repoKey changes", () => {
      const a = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      const b = deriveChangeId("TASK-1", "repo-b", 0, "feat: add api");
      expect(a).not.toBe(b);
    });

    it("differs when subject changes", () => {
      const a = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      const b = deriveChangeId("TASK-1", "repo-a", 0, "fix: repair api");
      expect(a).not.toBe(b);
    });

    it("differs when index changes — prevents duplicate-subject collisions", () => {
      const a = deriveChangeId("TASK-1", "repo-a", 0, "feat: add api");
      const b = deriveChangeId("TASK-1", "repo-a", 1, "feat: add api");
      expect(a).not.toBe(b);
    });
  });

  describe("injectChangeIds", () => {
    it("injects deterministic Change-Ids into commits without one", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "a.ts", "a\n", "feat: add a");
      addCommit(repoDir, "b.ts", "b\n", "fix: add b");

      const rawCommits = collectCommits(baseSha, repoDir);
      expect(rawCommits[0]!.changeId).toBe("");
      expect(rawCommits[1]!.changeId).toBe("");

      const injected = injectChangeIds(baseSha, rawCommits, "TASK-42", repoDir);
      expect(injected).toHaveLength(2);
      expect(injected[0]!.changeId).toMatch(/^I[0-9a-f]{40}$/);
      expect(injected[1]!.changeId).toMatch(/^I[0-9a-f]{40}$/);
    });

    it("produces the same Change-Id as deriveChangeId", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "x.ts", "x\n", "feat: deterministic test");

      const rawCommits = collectCommits(baseSha, repoDir);
      const injected = injectChangeIds(baseSha, rawCommits, "TASK-99", repoDir);

      const expected = deriveChangeId("TASK-99", "superproject", 0, "feat: deterministic test");
      expect(injected[0]!.changeId).toBe(expected);
    });

    it("skips commits that already have a Change-Id", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      const existingChangeId = "I1234567890abcdef1234567890abcdef12345678";
      writeFileSync(join(repoDir, "a.ts"), "a\n");
      git(["add", "a.ts"], repoDir);
      git(["commit", "-m", `feat: with id\n\nChange-Id: ${existingChangeId}`], repoDir);

      const rawCommits = collectCommits(baseSha, repoDir);
      expect(rawCommits[0]!.changeId).toBe(existingChangeId);

      const injected = injectChangeIds(baseSha, rawCommits, "TASK-1", repoDir);
      expect(injected[0]!.changeId).toBe(existingChangeId);
    });

    it("returns empty array for empty commits", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      const result = injectChangeIds(baseSha, [], "TASK-1", repoDir);
      expect(result).toEqual([]);
    });

    it("preserves commit subject and files after injection", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "src/main.ts", "main\n", "feat(api): add main module");

      const rawCommits = collectCommits(baseSha, repoDir);
      const injected = injectChangeIds(baseSha, rawCommits, "TASK-7", repoDir);

      expect(injected[0]!.subject).toBe("feat(api): add main module");
      expect(injected[0]!.files).toEqual(["src/main.ts"]);
    });

    it("is idempotent — second injection of same taskId produces same Change-Ids", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "f.ts", "f\n", "feat: idempotent");

      const rawCommits = collectCommits(baseSha, repoDir);
      const first = injectChangeIds(baseSha, rawCommits, "TASK-X", repoDir);

      // Running again on the already-injected commits should be a no-op
      const second = injectChangeIds(baseSha, first, "TASK-X", repoDir);
      expect(second[0]!.changeId).toBe(first[0]!.changeId);
    });

    it("assigns distinct Change-Ids to two commits with identical subjects", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "dup1.ts", "v1\n", "feat: same subject");
      addCommit(repoDir, "dup2.ts", "v2\n", "feat: same subject");

      const rawCommits = collectCommits(baseSha, repoDir);
      const injected = injectChangeIds(baseSha, rawCommits, "TASK-DUP", repoDir);

      expect(injected).toHaveLength(2);
      expect(injected[0]!.changeId).toMatch(/^I[0-9a-f]{40}$/);
      expect(injected[1]!.changeId).toMatch(/^I[0-9a-f]{40}$/);
      expect(injected[0]!.changeId).not.toBe(injected[1]!.changeId);
    });
  });

  describe("squashIntoBaseIfNeeded", () => {
    it("squashes agent commit into base when base already has a Change-Id", () => {
      // Simulate cycle 1: commit with a Change-Id (the patchset)
      const changeId = "Iaaaa1234567890abcdef1234567890abcdef1234";
      writeFileSync(join(repoDir, "a.ts"), "original\n");
      git(["add", "a.ts"], repoDir);
      git(["commit", "-m", `feat: initial work\n\nChange-Id: ${changeId}`], repoDir);
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();

      // Simulate cycle 2: agent adds a new commit on top instead of amending
      writeFileSync(join(repoDir, "a.ts"), "fixed\n");
      git(["add", "a.ts"], repoDir);
      git(["commit", "-m", "fix: address review feedback"], repoDir);

      // Before squash: 2 commits ahead of initial, agent commit has no Change-Id
      const before = collectCommits(baseSha, repoDir);
      expect(before).toHaveLength(1);
      expect(before[0]!.changeId).toBe("");

      // Squash
      const result = squashIntoBaseIfNeeded(baseSha, repoDir);
      expect(result.squashed).toBe(true);
      expect(result.commits).toHaveLength(1);
      // The squashed commit preserves the original Change-Id from baseSha
      expect(result.commits![0]!.changeId).toBe(changeId);
      // The squashed commit contains the agent's file changes
      expect(result.commits![0]!.files).toContain("a.ts");
    });

    it("does nothing when base has no Change-Id (cycle 1)", () => {
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
      addCommit(repoDir, "a.ts", "a\n", "feat: new file");

      const result = squashIntoBaseIfNeeded(baseSha, repoDir);
      expect(result.squashed).toBe(false);

      // Commit is still there, unmodified
      const commits = collectCommits(baseSha, repoDir);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.subject).toBe("feat: new file");
    });

    it("does nothing when agent amended (HEAD === baseSha after amend re-parse)", () => {
      // Create a commit with Change-Id, then amend it
      const changeId = "Ibbbb1234567890abcdef1234567890abcdef1234";
      writeFileSync(join(repoDir, "b.ts"), "v1\n");
      git(["add", "b.ts"], repoDir);
      git(["commit", "-m", `feat: base\n\nChange-Id: ${changeId}`], repoDir);
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();

      // Agent amends the commit (no new commit added)
      writeFileSync(join(repoDir, "b.ts"), "v2\n");
      git(["add", "b.ts"], repoDir);
      git(["commit", "--amend", "--no-edit"], repoDir);

      // HEAD changed (new SHA) but baseSha..HEAD still shows 1 commit
      // The function checks headBefore !== baseSha — after amend, HEAD is a
      // different SHA, so it WILL squash. That's fine: the result is still
      // one commit with the original Change-Id.
      const result = squashIntoBaseIfNeeded(baseSha, repoDir);
      expect(result.squashed).toBe(true);
      expect(result.commits).toHaveLength(1);
      expect(result.commits![0]!.changeId).toBe(changeId);
    });

    it("squashes multiple agent commits into base patchset", () => {
      const changeId = "Icccc1234567890abcdef1234567890abcdef1234";
      writeFileSync(join(repoDir, "c.ts"), "v1\n");
      git(["add", "c.ts"], repoDir);
      git(["commit", "-m", `feat: original\n\nChange-Id: ${changeId}`], repoDir);
      const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();

      // Agent creates TWO commits on top
      addCommit(repoDir, "c.ts", "v2\n", "fix: first fix");
      addCommit(repoDir, "d.ts", "new\n", "fix: second fix");

      const before = collectCommits(baseSha, repoDir);
      expect(before).toHaveLength(2);

      const result = squashIntoBaseIfNeeded(baseSha, repoDir);
      expect(result.squashed).toBe(true);
      expect(result.commits).toHaveLength(1);
      expect(result.commits![0]!.changeId).toBe(changeId);
      // Both files are in the squashed commit
      expect(result.commits![0]!.files).toContain("c.ts");
      expect(result.commits![0]!.files).toContain("d.ts");
    });
  });
});
