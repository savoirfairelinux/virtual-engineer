import { describe, it, expect } from "vitest";
import { buildFeatureBranchRef } from "../../src/vcs/branchNaming.js";

const TASK_ID = "b7ddee79-cc3b-4208-815c-70fcf177a49e";

describe("buildFeatureBranchRef", () => {
  it("builds feature/{shortId}-{slug} for a normal title", () => {
    expect(buildFeatureBranchRef(TASK_ID, "Add login button")).toBe("feature/b7ddee79-add-login-button");
  });

  it("falls back to legacy feature-{fullUuid} when title is undefined", () => {
    expect(buildFeatureBranchRef(TASK_ID, undefined)).toBe(`feature-${TASK_ID}`);
  });

  it("falls back to legacy feature-{fullUuid} when title is empty or whitespace", () => {
    expect(buildFeatureBranchRef(TASK_ID, "")).toBe(`feature-${TASK_ID}`);
    expect(buildFeatureBranchRef(TASK_ID, "   ")).toBe(`feature-${TASK_ID}`);
    expect(buildFeatureBranchRef(TASK_ID, null)).toBe(`feature-${TASK_ID}`);
  });

  it("falls back to legacy when title slugifies to empty (only punctuation)", () => {
    expect(buildFeatureBranchRef(TASK_ID, "!!!???")).toBe(`feature-${TASK_ID}`);
  });

  it("strips diacritics and lowercases", () => {
    expect(buildFeatureBranchRef(TASK_ID, "Créer l'écran d'accueil")).toBe("feature/b7ddee79-creer-l-ecran-d-accueil");
  });

  it("collapses runs of non-alphanumerics to a single dash", () => {
    expect(buildFeatureBranchRef(TASK_ID, "Fix  bug:   foo / bar")).toBe("feature/b7ddee79-fix-bug-foo-bar");
  });

  it("truncates slug to 40 chars and trims trailing dashes after truncation", () => {
    const long = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-extra-tail";
    const ref = buildFeatureBranchRef(TASK_ID, long);
    const slug = ref.replace("feature/b7ddee79-", "");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("trims trailing dashes when truncation lands on a separator", () => {
    expect(buildFeatureBranchRef(TASK_ID, "a".repeat(40) + " trailing")).toBe(`feature/b7ddee79-${"a".repeat(40)}`);
    expect(buildFeatureBranchRef(TASK_ID, "abc " + "x".repeat(60))).toMatch(/^feature\/b7ddee79-abc-x+$/);
  });

  it("is idempotent for the same inputs", () => {
    const ref1 = buildFeatureBranchRef(TASK_ID, "Add login button");
    const ref2 = buildFeatureBranchRef(TASK_ID, "Add login button");
    expect(ref1).toBe(ref2);
  });

  it("uses the first 8 chars of taskId as short id", () => {
    const ref = buildFeatureBranchRef("12345678-aaaa-bbbb-cccc-dddddddddddd", "Hello");
    expect(ref).toBe("feature/12345678-hello");
  });
});
