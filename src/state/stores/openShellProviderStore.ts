import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { managedOpenShellProviders } from "../schema.js";
import * as schema from "../schema.js";

export interface ManagedOpenShellProviderRecord {
  providerName: string;
  sandboxName: string;
  taskHash: string;
  createdAt: Date;
}

export interface OpenShellProviderStoreApi {
  recordManagedOpenShellProvider(record: ManagedOpenShellProviderRecord): Promise<void>;
  listManagedOpenShellProviders(): Promise<ManagedOpenShellProviderRecord[]>;
  deleteManagedOpenShellProvider(providerName: string): Promise<void>;
}

interface OpenShellProviderStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createOpenShellProviderStore(
  context: OpenShellProviderStoreContext,
): OpenShellProviderStoreApi {
  const { db } = context;

  async function recordManagedOpenShellProvider(record: ManagedOpenShellProviderRecord): Promise<void> {
    await db
      .insert(managedOpenShellProviders)
      .values(record)
      .onConflictDoUpdate({
        target: managedOpenShellProviders.providerName,
        set: {
          sandboxName: record.sandboxName,
          taskHash: record.taskHash,
          createdAt: record.createdAt,
        },
      });
  }

  async function listManagedOpenShellProviders(): Promise<ManagedOpenShellProviderRecord[]> {
    return db.query.managedOpenShellProviders.findMany({
      orderBy: [asc(managedOpenShellProviders.createdAt), asc(managedOpenShellProviders.providerName)],
    });
  }

  async function deleteManagedOpenShellProvider(providerName: string): Promise<void> {
    await db
      .delete(managedOpenShellProviders)
      .where(eq(managedOpenShellProviders.providerName, providerName));
  }

  return {
    recordManagedOpenShellProvider,
    listManagedOpenShellProviders,
    deleteManagedOpenShellProvider,
  };
}