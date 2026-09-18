import { getConfig } from "../config.js";
import { registerBuiltinPlugins } from "../plugins/init.js";
import { SqliteStateStore } from "../state/stateStore.js";
import { VcsConnectorFactory } from "./vcsFactory.js";
import { repairProviderChangeIdentities } from "./changeIdentityRepair.js";

function parseApply(args: string[]): boolean {
  const unexpected = args.filter((arg) => arg !== "--apply");
  if (unexpected.length > 0) {
    throw new Error(`Unknown argument(s): ${unexpected.join(", ")}. Supported option: --apply`);
  }
  return args.includes("--apply");
}

async function main(): Promise<void> {
  const apply = parseApply(process.argv.slice(2));
  const config = getConfig();
  registerBuiltinPlugins(
    config.adminAuthSecret !== undefined
      ? { adminAuthSecret: config.adminAuthSecret }
      : undefined,
  );
  const store = apply
    ? await SqliteStateStore.create(config.databasePath)
    : await SqliteStateStore.openReadOnly(config.databasePath);
  try {
    const factory = new VcsConnectorFactory({ adminAuthSecret: config.adminAuthSecret });
    const report = await repairProviderChangeIdentities({
      store,
      createConnector: (integration, context) => factory.getConnector(integration, context),
      apply,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.blockedTasks > 0) process.exitCode = 2;
  } finally {
    store.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Change identity repair failed: ${message}\n`);
  process.exitCode = 1;
});