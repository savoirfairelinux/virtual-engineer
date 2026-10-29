import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const databaseModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;

// Inline JavaScript works in both TypeScript development and compiled builds.
const SNAPSHOT_WORKER_SOURCE = `
  import { workerData } from "node:worker_threads";
  try {
    const { default: Database } = await import(workerData.databaseModuleUrl);
    const snapshot = new Database(workerData.destinationPath);
    try {
      snapshot.prepare("DELETE FROM user_sessions").run();
      snapshot.exec("VACUUM");
      snapshot.pragma("wal_checkpoint(TRUNCATE)");
      snapshot.pragma("journal_mode = DELETE");
    } finally {
      snapshot.close();
    }
  } catch (error) {
    // Native SQLite errors otherwise lose their message during worker serialization.
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
`;

export async function sanitizeBackupSnapshot(destinationPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SNAPSHOT_WORKER_SOURCE)}`), {
      workerData: { destinationPath, databaseModuleUrl },
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Backup snapshot worker exited with code ${code}.`));
    });
  });
}
