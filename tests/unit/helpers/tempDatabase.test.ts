import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupTempDatabase, tempDatabasePath } from "./tempDatabase.js";

describe("temporary test databases", () => {
  it("removes a database and its SQLite sidecar files", () => {
    const dbPath = tempDatabasePath("ve-cleanup-test");
    const artifacts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const artifact of artifacts) {
      writeFileSync(artifact, "test");
    }

    cleanupTempDatabase(dbPath);

    expect(artifacts.every((artifact) => !existsSync(artifact))).toBe(true);
  });

  it("removes a dedicated database directory", () => {
    const dbPath = tempDatabasePath("ve-cleanup-directory-test", { directory: true });
    writeFileSync(dbPath, "test");
    const directory = dbPath.slice(0, dbPath.lastIndexOf("/"));

    cleanupTempDatabase(dbPath);

    expect(existsSync(directory)).toBe(false);
  });
});
