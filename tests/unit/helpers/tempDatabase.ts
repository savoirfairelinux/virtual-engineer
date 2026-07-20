import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";

interface TempDatabaseOptions {
  directory?: boolean;
}

const cleanupDirectories = new Map<string, string>();

export function cleanupTempDatabase(dbPath: string): void {
  const cleanupDirectory = cleanupDirectories.get(dbPath);
  cleanupDirectories.delete(dbPath);

  if (cleanupDirectory !== undefined) {
    rmSync(cleanupDirectory, { recursive: true, force: true });
    return;
  }

  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(path, { force: true });
  }
}

export function tempDatabasePath(
  prefix: string,
  options: TempDatabaseOptions = {}
): string {
  const uniqueName = `${prefix}-${randomUUID()}`;
  let dbPath: string;

  if (options.directory === true) {
    const directory = join(tmpdir(), uniqueName);
    mkdirSync(directory, { recursive: true });
    dbPath = join(directory, "ve.db");
    cleanupDirectories.set(dbPath, directory);
  } else {
    dbPath = join(tmpdir(), `${uniqueName}.db`);
  }

  onTestFinished(() => cleanupTempDatabase(dbPath));
  return dbPath;
}
