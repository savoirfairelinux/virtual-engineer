/**
 * Database migration script — creates the SQLite schema
 * Run via: npm run db:migrate
 */

import { getConfig } from "../config.js";
import { SqliteStateStore } from "./stateStore.js";
import { getLogger } from "../logger.js";

const log = getLogger("migrate");

/** Initialise the SQLite database schema and exit the process when done. */
async function migrate(): Promise<void> {
  const config = getConfig();
  log.info({ dbPath: config.databasePath }, "Initializing database...");

  try {
    await SqliteStateStore.create(config.databasePath);
    log.info("✓ Database schema created/verified successfully");
    process.exit(0);
  } catch (err) {
    log.error({ err }, "Migration failed");
    process.exit(1);
  }
}

migrate();
