/**
 * Tests for the agent-worker project-brief cache helpers.
 *
 * The worker is a plain JS module that runs inside Docker, so we test the
 * logic by replicating the key functions (loadProjectBrief, injectProjectBrief,
 * writeProjectBriefAtomic) exactly as they appear in agent-worker/index.js and
 * verifying them against a real temporary cache directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PROJECT_BRIEF_FILENAME = "context.md";
const PROJECT_BRIEF_MAX_BYTES = 8 * 1024;

function briefPath(cacheDir: string): string {
  return join(cacheDir, PROJECT_BRIEF_FILENAME);
}

function loadProjectBrief(cacheDir: string): string {
  if (!cacheDir) return "";
  const path = briefPath(cacheDir);
  if (!existsSync(path)) return "";
  let brief = readFileSync(path, "utf8").trim();
  if (!brief) return "";
  if (Buffer.byteLength(brief, "utf8") > PROJECT_BRIEF_MAX_BYTES) {
    brief = Buffer.from(brief, "utf8").subarray(0, PROJECT_BRIEF_MAX_BYTES).toString("utf8");
  }
  return brief;
}

function injectProjectBrief(cacheDir: string, userPrompt: string): string {
  const brief = loadProjectBrief(cacheDir);
  if (!brief) return userPrompt;
  return [
    "## Project knowledge from previous tasks (may be stale — verify before trusting)",
    "",
    brief,
    "",
    "---",
    "",
    userPrompt,
  ].join("\n");
}

function writeProjectBriefAtomic(cacheDir: string, brief: string): void {
  if (!cacheDir) return;
  const tmpPath = join(cacheDir, `.${PROJECT_BRIEF_FILENAME}.tmp.${process.pid}`);
  writeFileSync(tmpPath, brief, "utf8");
  renameSync(tmpPath, briefPath(cacheDir));
}

describe("agent-worker project-brief cache", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "ve-cache-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("injects the brief when context.md is present", () => {
    writeFileSync(briefPath(cacheDir), "Architecture: monolith\nTests: vitest", "utf8");
    const result = injectProjectBrief(cacheDir, "Fix the login bug");
    expect(result).toContain("Project knowledge from previous tasks");
    expect(result).toContain("Architecture: monolith");
    expect(result).toContain("Fix the login bug");
    expect(result.indexOf("Architecture")).toBeLessThan(result.indexOf("Fix the login bug"));
  });

  it("returns the prompt unchanged when no brief exists", () => {
    const result = injectProjectBrief(cacheDir, "Fix the login bug");
    expect(result).toBe("Fix the login bug");
  });

  it("returns the prompt unchanged when the brief file is empty", () => {
    writeFileSync(briefPath(cacheDir), "   \n  ", "utf8");
    const result = injectProjectBrief(cacheDir, "Fix the login bug");
    expect(result).toBe("Fix the login bug");
  });

  it("treats an unset cache dir as no-op", () => {
    expect(loadProjectBrief("")).toBe("");
    expect(injectProjectBrief("", "prompt")).toBe("prompt");
  });

  it("truncates a brief larger than the max byte budget", () => {
    const big = "x".repeat(PROJECT_BRIEF_MAX_BYTES + 5000);
    writeFileSync(briefPath(cacheDir), big, "utf8");
    const loaded = loadProjectBrief(cacheDir);
    expect(Buffer.byteLength(loaded, "utf8")).toBe(PROJECT_BRIEF_MAX_BYTES);
  });

  it("writes the brief atomically, overwriting an existing file", () => {
    writeFileSync(briefPath(cacheDir), "old brief", "utf8");
    writeProjectBriefAtomic(cacheDir, "new brief");
    expect(readFileSync(briefPath(cacheDir), "utf8")).toBe("new brief");
    expect(existsSync(join(cacheDir, `.${PROJECT_BRIEF_FILENAME}.tmp.${process.pid}`))).toBe(false);
  });

  it("round-trips a written brief back through load", () => {
    writeProjectBriefAtomic(cacheDir, "Build: npm run build\nLint: npm run lint");
    expect(loadProjectBrief(cacheDir)).toBe("Build: npm run build\nLint: npm run lint");
  });
});
