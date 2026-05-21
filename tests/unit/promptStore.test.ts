/**
 * Unit tests for PromptStore — implemented in SqliteStateStore.
 *
 * Covers CRUD for the `prompts` table: getPrompts, getPrompt, upsertPrompt.
 * Also verifies that the built-in prompts are seeded with default content
 * on first access / DB creation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

function tempDbPath(): string {
  // Use a unique subdirectory per test so each store has its own prompt-override
  // directory and cannot interfere with other concurrent tests.
  return join(tmpdir(), `ve-prompts-test-${randomUUID()}`, "ve.db");
}

describe("SqliteStateStore — PromptStore", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  // ── getPrompts ─────────────────────────────────────────────────────────────

  describe("getPrompts", () => {
    it("returns at least the two built-in prompts on a fresh database", async () => {
      const prompts = await store.getPrompts();

      expect(prompts.length).toBeGreaterThanOrEqual(6);
      const ids = prompts.map((p) => p.id);
      expect(ids).toContain("system_gerrit_code");
      expect(ids).toContain("user_gerrit_review");
    });

    it("each built-in prompt has a non-empty label and content", async () => {
      const prompts = await store.getPrompts();

      for (const prompt of prompts) {
        expect(typeof prompt.label).toBe("string");
        expect(prompt.label.length).toBeGreaterThan(0);
        expect(typeof prompt.content).toBe("string");
        expect(prompt.content.length).toBeGreaterThan(0);
        expect(prompt.updatedAt).toBeInstanceOf(Date);
      }
    });

    it("returns custom prompts after upsert", async () => {
      await store.upsertPrompt("user_gerrit_review", "Custom instructions content");

      const prompts = await store.getPrompts();
      const instrPrompt = prompts.find((p) => p.id === "user_gerrit_review");

      expect(instrPrompt).toBeDefined();
      expect(instrPrompt!.content).toBe("Custom instructions content");
    });

    it("returns all prompts including newly upserted ones", async () => {
      await store.upsertPrompt("user_gerrit_review", "Instructions v2");

      const prompts = await store.getPrompts();

      expect(prompts.length).toBeGreaterThanOrEqual(6);
    });
  });

  // ── getPrompt ──────────────────────────────────────────────────────────────

  describe("getPrompt", () => {
    it("returns the built-in 'system_gerrit_code' prompt with default content", async () => {
      const prompt = await store.getPrompt("system_gerrit_code");

      expect(prompt).not.toBeNull();
      expect(prompt!.id).toBe("system_gerrit_code");
      expect(prompt!.label).toMatch(/gerrit/i);
      expect(prompt!.content.length).toBeGreaterThan(10);
      expect(prompt!.updatedAt).toBeInstanceOf(Date);
    });

    it("returns the built-in 'user_gerrit_review' prompt with default content", async () => {
      const prompt = await store.getPrompt("user_gerrit_review");

      expect(prompt).not.toBeNull();
      expect(prompt!.id).toBe("user_gerrit_review");
      expect(prompt!.label).toMatch(/gerrit/i);
      expect(prompt!.content.length).toBeGreaterThan(10);
    });

    it("returns null for an unknown prompt id", async () => {
      const prompt = await store.getPrompt("nonexistent");

      expect(prompt).toBeNull();
    });

    it("returns the updated content after upsert", async () => {
      const newContent = "You are a test engineer. Only write tests.";
      await store.upsertPrompt("user_gerrit_review", newContent);

      const prompt = await store.getPrompt("user_gerrit_review");

      expect(prompt!.content).toBe(newContent);
    });
  });

  // ── upsertPrompt ───────────────────────────────────────────────────────────

  describe("upsertPrompt", () => {
    it("creates a new prompt record when none exists", async () => {
      const result = await store.upsertPrompt("user_gerrit_review", "New instructions content");

      expect(result.id).toBe("user_gerrit_review");
      expect(result.content).toBe("New instructions content");
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it("updates an existing prompt when called again with the same id", async () => {
      await store.upsertPrompt("user_gerrit_review", "First version");
      const updated = await store.upsertPrompt("user_gerrit_review", "Second version");

      expect(updated.id).toBe("user_gerrit_review");
      expect(updated.content).toBe("Second version");
    });

    it("preserves the label field when updating content", async () => {
      const initial = await store.getPrompt("user_gerrit_review");
      const originalLabel = initial!.label;

      await store.upsertPrompt("user_gerrit_review", "Updated content");
      const afterUpdate = await store.getPrompt("user_gerrit_review");

      expect(afterUpdate!.label).toBe(originalLabel);
    });

    it("updates updatedAt timestamp on each upsert", async () => {
      const before = await store.upsertPrompt("user_gerrit_review", "v1");
      // Small delay to ensure timestamps differ
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const after = await store.upsertPrompt("user_gerrit_review", "v2");

      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    });

    it("returns the persisted prompt (verifiable via getPrompt)", async () => {
      const content = "You are a diligent software engineer.";
      await store.upsertPrompt("user_gerrit_review", content);

      const retrieved = await store.getPrompt("user_gerrit_review");

      expect(retrieved!.content).toBe(content);
    });

    it("stores multi-line content with newlines intact", async () => {
      const multilineContent = "Line 1\nLine 2\n\nLine 4 after blank";
      await store.upsertPrompt("user_gerrit_review", multilineContent);

      const retrieved = await store.getPrompt("user_gerrit_review");

      expect(retrieved!.content).toBe(multilineContent);
    });

    it("stores large content without truncation", async () => {
      const largeContent = "x".repeat(10_000);
      await store.upsertPrompt("user_gerrit_review", largeContent);

      const retrieved = await store.getPrompt("user_gerrit_review");

      expect(retrieved!.content).toHaveLength(10_000);
    });
  });

  // ── isolation between databases ────────────────────────────────────────────

  describe("isolation across store instances", () => {
    it("changes in one store instance are not visible in a second store on a different db", async () => {
      await store.upsertPrompt("user_gerrit_review", "store1 content");

      const store2 = await SqliteStateStore.create(tempDbPath());
      try {
        const prompt = await store2.getPrompt("user_gerrit_review");
        // store2 has different db path — it should have the default, not "store1 content"
        expect(prompt!.content).not.toBe("store1 content");
      } finally {
        store2.close();
      }
    });
  });

  // ── createPrompt ───────────────────────────────────────────────────────────

  describe("createPrompt", () => {
    it("creates a new prompt with user-provided label and generated id", async () => {
      const prompt = await store.createPrompt("My Custom Prompt", "This is custom content");

      expect(prompt.id).toBeDefined();
      expect(prompt.id).not.toBeNull();
      expect(prompt.label).toBe("My Custom Prompt");
      expect(prompt.content).toBe("This is custom content");
    });

    it("normalizes label to id (lowercase, spaces to dashes)", async () => {
      const prompt = await store.createPrompt("My Test Prompt", "content");

      expect(prompt.id).toMatch(/^my-test-prompt/);
    });

    it("rejects duplicate label names with appropriate error", async () => {
      await store.createPrompt("Test Prompt", "content1");

      await expect(
        store.createPrompt("Test Prompt", "content2")
      ).rejects.toThrow(/already exists|duplicate/i);
    });

    it("rejects invalid (empty) labels", async () => {
      await expect(
        store.createPrompt("", "content")
      ).rejects.toThrow(/invalid|empty|label/i);
    });

    it("accepts special characters and normalizes them", async () => {
      const prompt = await store.createPrompt("My@Test#Prompt!", "content");

      expect(prompt.id).toBeDefined();
      // id should be normalized (special chars removed/replaced)
      expect(typeof prompt.id).toBe("string");
      expect(prompt.id.length).toBeGreaterThan(0);
    });

    it("stores multi-line content correctly", async () => {
      const multilineContent = "Line 1\nLine 2\n\nLine 4";
      const prompt = await store.createPrompt("Multiline Prompt", multilineContent);

      expect(prompt.content).toBe(multilineContent);

      const retrieved = await store.getPrompt(prompt.id);
      expect(retrieved!.content).toBe(multilineContent);
    });

    it("sets timestamps on creation", async () => {
      const before = Math.floor(Date.now() / 1000) - 1; // seconds, subtract 1 for safety
      const prompt = await store.createPrompt("Timestamped Prompt", "content");
      const after = Math.floor(Date.now() / 1000) + 1; // seconds, add 1 for safety

      expect(prompt.updatedAt).toBeInstanceOf(Date);
      const timestamp = Math.floor(prompt.updatedAt.getTime() / 1000); // convert to seconds
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("persists created prompt to database", async () => {
      const prompt = await store.createPrompt("Persisted Prompt", "persistent content");

      const retrieved = await store.getPrompt(prompt.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.label).toBe("Persisted Prompt");
      expect(retrieved!.content).toBe("persistent content");
    });
  });

  // ── deletePrompt ───────────────────────────────────────────────────────────

  describe("deletePrompt", () => {
    it("deletes a custom prompt successfully", async () => {
      const prompt = await store.createPrompt("To Delete", "content");
      const id = prompt.id;

      await store.deletePrompt(id);

      const retrieved = await store.getPrompt(id);
      expect(retrieved).toBeNull();
    });

    it("rejects deletion of the built-in 'system_gerrit_code' prompt", async () => {
      await expect(
        store.deletePrompt("system_gerrit_code")
      ).rejects.toThrow(/cannot delete|built-in/i);
    });

    it("rejects deletion of the built-in 'user_gerrit_review' prompt", async () => {
      await expect(
        store.deletePrompt("user_gerrit_review")
      ).rejects.toThrow(/cannot delete|built-in/i);
    });

    it("throws error when attempting to delete non-existent prompt", async () => {
      await expect(
        store.deletePrompt("does-not-exist")
      ).rejects.toThrow(/not found|does not exist|not exist/i);
    });

    it("allows re-creation after deletion of custom prompt", async () => {
      const prompt1 = await store.createPrompt("Reusable Name", "v1");
      await store.deletePrompt(prompt1.id);

      const prompt2 = await store.createPrompt("Reusable Name", "v2");
      expect(prompt2.label).toBe("Reusable Name");
      expect(prompt2.content).toBe("v2");
    });

    it("does not affect other prompts when one is deleted", async () => {
      const p1 = await store.createPrompt("Prompt 1", "content 1");
      const p2 = await store.createPrompt("Prompt 2", "content 2");

      await store.deletePrompt(p1.id);

      const allPrompts = await store.getPrompts();
      const p2Retrieved = allPrompts.find((p) => p.id === p2.id);
      expect(p2Retrieved).toBeDefined();
      expect(p2Retrieved!.content).toBe("content 2");
    });
  });

  // ── normalizePromptId ──────────────────────────────────────────────────────

  describe("normalizePromptId (internal helper)", () => {
    // Note: normalizePromptId is a private method; test indirectly via createPrompt

    it("converts spaces to dashes when generating id from label", async () => {
      const prompt = await store.createPrompt("My Test Label", "content");
      expect(prompt.id).toMatch(/^my-test-label/);
    });

    it("converts uppercase to lowercase in id", async () => {
      const prompt = await store.createPrompt("UPPERCASE LABEL", "content");
      expect(prompt.id).toMatch(/^uppercase-label/);
    });

    it("handles mixed case normalization", async () => {
      const prompt = await store.createPrompt("Mixed Case Label", "content");
      expect(prompt.id).toMatch(/^mixed-case-label/);
    });

    it("truncates very long labels to reasonable length", async () => {
      const longLabel = "a".repeat(100);
      const prompt = await store.createPrompt(longLabel, "content");
      expect(prompt.id.length).toBeLessThanOrEqual(100);
    });

    it("removes or replaces special characters", async () => {
      const prompt = await store.createPrompt("Label@With#Special$Chars!", "content");
      // Should not throw, and id should be a valid string
      expect(typeof prompt.id).toBe("string");
      expect(prompt.id.length).toBeGreaterThan(0);
      // Should not contain special chars (except dashes)
      expect(prompt.id).toMatch(/^[a-z0-9\-]+$/);
    });
  });
});
