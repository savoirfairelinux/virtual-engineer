import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROMPT_IDS } from "../../src/domain/prompts.js";

const TEST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(TEST_DIR, "../..");

const PROMPTS_DIR = resolve(REPO_ROOT, "prompts");
const SKILLS_DIR = resolve(REPO_ROOT, ".github/skills");
const PROMPT_STORE_PATH = resolve(REPO_ROOT, "src/state/stores/promptStore.ts");

function collectMarkdownFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const nested = entries.flatMap((entry) => {
    const full = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return collectMarkdownFiles(full);
    }
    return entry.name.endsWith(".md") ? [full] : [];
  });
  return nested;
}

function resolveMarkdownTarget(sourceFile: string, target: string): string | null {
  if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:") || target.startsWith("#")) {
    return null;
  }
  const [pathOnly] = target.split("#");
  if (!pathOnly) {
    return null;
  }
  return resolve(sourceFile, "..", pathOnly);
}

describe("prompt + skill integrity", () => {
  it("keeps built-in prompt ids, prompt files, and seeded entries aligned", () => {
    const promptFiles = readdirSync(PROMPTS_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/u, ""))
      .sort();
    const builtInIds = [...BUILT_IN_PROMPT_IDS].sort();

    expect(promptFiles).toEqual(builtInIds);

    const promptStoreSource = readFileSync(PROMPT_STORE_PATH, "utf8");
    for (const id of builtInIds) {
      expect(promptStoreSource).toContain(`id: "${id}"`);
      expect(promptStoreSource).toContain(`prompts/${id}.md`);
    }
  });

  it("keeps prompt role contracts explicit in content", () => {
    const systemGeneric = readFileSync(resolve(PROMPTS_DIR, "system_generic_code.md"), "utf8");
    const instructionsGeneric = readFileSync(resolve(PROMPTS_DIR, "instructions_generic_code.md"), "utf8");
    const feedbackInstructions = readFileSync(resolve(PROMPTS_DIR, "instructions_feedback_code.md"), "utf8");
    const systemReview = readFileSync(resolve(PROMPTS_DIR, "system_review.md"), "utf8");
    const instructionsReview = readFileSync(resolve(PROMPTS_DIR, "instructions_review.md"), "utf8");

    expect(systemGeneric).toMatch(/autonomous software engineer/i);
    expect(systemGeneric).toMatch(/create atomic local commits/i);
    expect(systemGeneric).toMatch(/do not add workflow-managed footers or push/i);

    expect(instructionsGeneric).toMatch(/ticket workflow/i);
    expect(instructionsGeneric).toMatch(/expected behavior, constraints, and acceptance criteria/i);

    expect(feedbackInstructions).toMatch(/feedback workflow/i);
    expect(feedbackInstructions).toMatch(/amend the existing commit/i);

    expect(systemReview).toMatch(/read-only review/i);
    expect(systemReview).toMatch(/do not modify the workspace/i);
    expect(instructionsReview).toMatch(/actionable issues introduced by the change/i);
  });

  it("keeps skill and prompt markdown links and concrete file references valid", () => {
    const markdownFiles = [
      ...collectMarkdownFiles(SKILLS_DIR),
      ...collectMarkdownFiles(PROMPTS_DIR),
    ];

    const missingLinks: string[] = [];
    const missingRefs: string[] = [];
    const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
    const codePathPattern = /`((?:src|tests|agent-worker|\.github|docs)\/[^`\n]+)`/gu;

    for (const filePath of markdownFiles) {
      const content = readFileSync(filePath, "utf8");

      for (const match of content.matchAll(markdownLinkPattern)) {
        const target = match[1];
        if (!target) {
          continue;
        }
        const resolved = resolveMarkdownTarget(filePath, target.trim());
        if (!resolved) {
          continue;
        }
        if (!existsSync(resolved)) {
          const relativeSource = filePath.replace(`${REPO_ROOT}/`, "");
          missingLinks.push(`${relativeSource} -> ${target}`);
        }
      }

      for (const match of content.matchAll(codePathPattern)) {
        const pathRef = match[1];
        if (
          !pathRef
          || pathRef.includes("*")
          || pathRef.includes("<")
          || pathRef.includes(">")
          || pathRef.includes("{")
          || pathRef.includes("}")
        ) {
          continue;
        }
        const resolved = resolve(REPO_ROOT, pathRef);
        if (!existsSync(resolved)) {
          const relativeSource = filePath.replace(`${REPO_ROOT}/`, "");
          missingRefs.push(`${relativeSource} -> ${pathRef}`);
        }
      }
    }

    expect(missingLinks).toEqual([]);
    expect(missingRefs).toEqual([]);
  });
});
