import Database from "better-sqlite3";
import { getConfig } from "../config.js";
import { registerBuiltinPlugins } from "../plugins/init.js";
import { sanitizeErrorDetail } from "../utils/redactUrl.js";
import { repairHostedChangeIdentities } from "./changeIdentityRepair.js";
import { VcsConnectorFactory } from "./vcsFactory.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let apply = false;
  let taskId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--task") {
      const value = args[++index];
      if (!value || value.startsWith("--") || taskId !== undefined) {
        throw new Error("--task requires exactly one task id");
      }
      taskId = value;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}. Supported options: --apply, --task <id>`);
    }
  }
  const config = getConfig();
  registerBuiltinPlugins(config.adminAuthSecret === undefined ? undefined : { adminAuthSecret: config.adminAuthSecret });
  const database = new Database(config.databasePath, { readonly: !apply, fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const factory = new VcsConnectorFactory({ adminAuthSecret: config.adminAuthSecret });
    const report = await repairHostedChangeIdentities({
      database, apply, taskId,
      createConnector: (integration, context) => factory.getConnector(integration, context),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.blocked > 0) {
      process.stderr.write(`${report.blocked} repair target(s) blocked; no changes applied.\n`);
      process.exitCode = 2;
    }
  } finally {
    database.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Change identity repair failed: ${sanitizeErrorDetail(
    error instanceof Error ? error.message : String(error),
  )}\n`);
  process.exitCode = 1;
});
