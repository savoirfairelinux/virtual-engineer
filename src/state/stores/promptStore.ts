import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Prompt, PromptType } from "../../interfaces.js";
import { prompts } from "../schema.js";
import * as schema from "../schema.js";

export interface PromptStoreApi {
  getPrompts(): Promise<Prompt[]>;
  getPrompt(id: string): Promise<Prompt | null>;
  upsertPrompt(id: string, content: string): Promise<Prompt>;
  createPrompt(label: string, content: string, promptType: PromptType): Promise<Prompt>;
  deletePrompt(id: string): Promise<void>;
  seedBuiltInPrompts(): Promise<void>;
}

interface PromptStoreContext {
  db: BetterSQLite3Database<typeof schema>;
  dbDir: string;
}

const BUILT_IN_PROMPT_IDS = new Set([
  "system_generic_code",
  "instructions_generic_code",
  "system_gerrit_code",
  "system_gitlab_code",
  "instructions_gerrit_code",
  "instructions_gitlab_code",
  "instructions_feedback_code",
  "system_gerrit_review",
  "system_gitlab_review",
  "system_github_review",
  "instructions_gerrit_review",
  "instructions_gitlab_review",
  "instructions_github_review",
]);

const BUILT_IN_SYSTEM_PROMPT_IDS = new Set([
  "system_generic_code",
  "system_gerrit_code",
  "system_gitlab_code",
  "system_gerrit_review",
  "system_gitlab_review",
  "system_github_review",
]);

function builtInPromptType(id: string): PromptType {
  return BUILT_IN_SYSTEM_PROMPT_IDS.has(id) ? "system" : "instructions";
}

export function createPromptStore(context: PromptStoreContext): PromptStoreApi {
  const { db, dbDir } = context;

  function rowToPrompt(row: typeof prompts.$inferSelect): Prompt {
    return {
      id: row.id,
      label: row.label,
      content: row.content,
      promptType: row.promptType === "system" ? "system" : "instructions",
      updatedAt: row.updatedAt,
    };
  }

  function normalizePromptId(label: string): string {
    return label
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/^-+|-+$/g, "")
      .substring(0, 64);
  }

  function defaultPromptLabel(id: string): string {
    return id;
  }

  async function getPrompts(): Promise<Prompt[]> {
    const rows = await db.query.prompts.findMany({
      orderBy: (prompt, { asc }) => [asc(prompt.id)],
    });
    return rows.map((row) => rowToPrompt(row));
  }

  async function getPrompt(id: string): Promise<Prompt | null> {
    const row = await db.query.prompts.findFirst({
      where: eq(prompts.id, id),
    });
    return row ? rowToPrompt(row) : null;
  }

  async function readPromptOverride(id: string): Promise<string | null> {
    try {
      return await readFile(join(dbDir, "prompts", `${id}.md`), "utf8");
    } catch {
      return null;
    }
  }

  async function writePromptOverride(id: string, content: string): Promise<void> {
    try {
      const dir = join(dbDir, "prompts");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.md`), content, "utf8");
    } catch {
      // Non-fatal: DB is the primary persistence layer.
    }
  }

  async function readPromptFile(relativePath: string): Promise<string> {
    const url = new URL(relativePath, import.meta.url);
    try {
      return await readFile(url, "utf8");
    } catch (err) {
      throw new Error(
        `Required prompt file not found: ${url.pathname} — ensure all files in prompts/ are present before starting the server. (${String(err)})`
      );
    }
  }

  async function loadDefaultPrompts(): Promise<Array<{ id: string; label: string; promptType: PromptType; content: string }>> {
    const entries: Array<{ id: string; label: string; promptType: PromptType; file: string }> = [
      { id: "system_generic_code", label: "System Prompt — Generic (code)", promptType: "system", file: "../../../prompts/system_generic_code.md" },
      { id: "instructions_generic_code", label: "Instructions Prompt — Generic (code)", promptType: "instructions", file: "../../../prompts/instructions_generic_code.md" },
      { id: "system_gerrit_code", label: "System Prompt — Gerrit (code)", promptType: "system", file: "../../../prompts/system_gerrit_code.md" },
      { id: "system_gitlab_code", label: "System Prompt — GitLab (code)", promptType: "system", file: "../../../prompts/system_gitlab_code.md" },
      { id: "instructions_gerrit_code", label: "Instructions Prompt — Gerrit (code)", promptType: "instructions", file: "../../../prompts/instructions_gerrit_code.md" },
      { id: "instructions_gitlab_code", label: "Instructions Prompt — GitLab (code)", promptType: "instructions", file: "../../../prompts/instructions_gitlab_code.md" },
      { id: "instructions_feedback_code", label: "Instructions Prompt — Feedback Cycle (code)", promptType: "instructions", file: "../../../prompts/instructions_feedback_code.md" },
      { id: "system_gerrit_review", label: "System Prompt — Gerrit (review)", promptType: "system", file: "../../../prompts/system_gerrit_review.md" },
      { id: "system_gitlab_review", label: "System Prompt — GitLab MR (review)", promptType: "system", file: "../../../prompts/system_gitlab_review.md" },
      { id: "instructions_gerrit_review", label: "Instructions Prompt — Gerrit (review)", promptType: "instructions", file: "../../../prompts/instructions_gerrit_review.md" },
      { id: "instructions_gitlab_review", label: "Instructions Prompt — GitLab MR (review)", promptType: "instructions", file: "../../../prompts/instructions_gitlab_review.md" },
      { id: "system_github_review", label: "System Prompt — GitHub PR (review)", promptType: "system", file: "../../../prompts/system_github_review.md" },
      { id: "instructions_github_review", label: "Instructions Prompt — GitHub PR (review)", promptType: "instructions", file: "../../../prompts/instructions_github_review.md" },
    ];

    const results = await Promise.all(
      entries.map(async (entry) => {
        const override = await readPromptOverride(entry.id);
        const content = override ?? await readPromptFile(entry.file);
        return { id: entry.id, label: entry.label, promptType: entry.promptType, content };
      })
    );
    return results;
  }

  async function seedBuiltInPrompts(): Promise<void> {
    const now = new Date();
    const defaults = await loadDefaultPrompts();

    for (const prompt of defaults) {
      const existing = await getPrompt(prompt.id);
      if (existing) {
        if (existing.content !== prompt.content) {
          await db
            .update(prompts)
            .set({ content: prompt.content, updatedAt: now })
            .where(eq(prompts.id, prompt.id));
        }
        continue;
      }

      await db.insert(prompts).values({
        id: prompt.id,
        label: prompt.label,
        content: prompt.content,
        promptType: prompt.promptType,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async function upsertPrompt(id: string, content: string): Promise<Prompt> {
    const now = new Date();
    const existing = await getPrompt(id);

    if (existing) {
      await db
        .update(prompts)
        .set({
          label: existing.label,
          content,
          updatedAt: now,
        })
        .where(eq(prompts.id, id));
    } else {
      await db.insert(prompts).values({
        id,
        label: defaultPromptLabel(id),
        content,
        promptType: builtInPromptType(id),
        createdAt: now,
        updatedAt: now,
      });
    }

    if (BUILT_IN_PROMPT_IDS.has(id)) {
      await writePromptOverride(id, content);
    }

    const result = await getPrompt(id);
    if (!result) throw new Error(`Failed to upsert prompt ${id}`);
    return result;
  }

  async function createPrompt(label: string, content: string, promptType: PromptType): Promise<Prompt> {
    const id = normalizePromptId(label);

    if (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`Invalid prompt id derived from label: "${id}"`);
    }

    const existing = await getPrompt(id);
    if (existing) {
      throw new Error(`Prompt with id "${id}" already exists`);
    }

    const now = new Date();
    await db.insert(prompts).values({
      id,
      label,
      content,
      promptType,
      createdAt: now,
      updatedAt: now,
    });

    const result = await getPrompt(id);
    if (!result) throw new Error(`Failed to create prompt ${id}`);
    return result;
  }

  async function deletePrompt(id: string): Promise<void> {
    const existing = await getPrompt(id);
    if (!existing) {
      throw new Error(`Prompt not found: "${id}"`);
    }
    if (BUILT_IN_PROMPT_IDS.has(id)) {
      throw new Error(`Cannot delete built-in prompt: "${id}"`);
    }

    await db.delete(prompts).where(eq(prompts.id, id));
  }

  return {
    getPrompts,
    getPrompt,
    upsertPrompt,
    createPrompt,
    deletePrompt,
    seedBuiltInPrompts,
  };
}
