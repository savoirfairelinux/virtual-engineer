import { describe, expect, it } from "vitest";
import { collectRepositoryHistory } from "../../src/review/repositoryHistory.js";

const R = "\x1e";
const F = "\x1f";

describe("collectRepositoryHistory", () => {
  it("renders recent target-branch commits and per-file history", async () => {
    const calls: string[][] = [];
    const history = await collectRepositoryHistory(async (args) => {
      calls.push(args);
      if (args.at(-1) === "--") {
        return `${R}abc1234${F}2026-11-20${F}net: fix timeout\n\nLonger body.\n\nSigned-off-by: A <a@example.com>\n${R}def5678${F}2026-11-19${F}docs: typo\n`;
      }
      return args.at(-1) === "src/a.c" ? `${R}abc1234${F}2026-11-20${F}net: fix timeout\n` : "";
    }, { branch: "refs/heads/main", paths: ["src/a.c", "src/new.c", "src/a.c"] });

    expect(calls[0]).toEqual(expect.arrayContaining(["log", "refs/heads/main", "--"]));
    expect(calls.map((args) => args.at(-1))).toEqual(["--", "src/a.c", "src/new.c"]);
    expect(history).toBe([
      "### Recent commits on refs/heads/main",
      "",
      "commit abc1234 (2026-11-20)",
      "net: fix timeout\n\nLonger body.\n\nSigned-off-by: A <a@example.com>",
      "",
      "commit def5678 (2026-11-19)",
      "docs: typo",
      "",
      "### Recent commits touching the changed files",
      "",
      "`src/a.c`:",
      "- abc1234 2026-11-20 net: fix timeout",
    ].join("\n"));
  });

  it("returns nothing without history and bounds a long one", async () => {
    expect(await collectRepositoryHistory(async () => "", { branch: "main", paths: [] })).toBeUndefined();
    const long = await collectRepositoryHistory(
      async (args) => args.at(-1) === "--"
        ? Array.from({ length: 20 }, (_, i) => `${R}h${i}${F}2026-01-01${F}${"x".repeat(5_000)}`).join("")
        : "",
      { branch: "main", paths: [] },
    );
    expect(long?.length).toBeLessThan(16_100);
    expect(long).toMatch(/\[\.\.\. history truncated \.\.\.\]$/);
  });
});
