/**
 * Pino logger factory.
 *
 * Output is silent in `test` environments, pretty-printed in development,
 * and plain JSON in production. All modules should call `getLogger(component)`
 * rather than constructing their own Pino instance.
 */
import pino from "pino";

let rootLogger: pino.Logger | null = null;

/** Entity kinds whose ID log fields are enriched with human-readable context. */
export type LogEntityKind = "integration" | "project" | "agent" | "task" | "user" | "prompt";

/**
 * Synchronous lookup returning readable fields for an entity ID (for example
 * `{ projectName: "Platform" }`), or `undefined` when the entity is unknown.
 */
export type LogContextResolver = (kind: LogEntityKind, id: string) => Readonly<Record<string, string>> | undefined;

const ENRICHED_ID_FIELDS: Readonly<Record<string, LogEntityKind>> = {
  integrationId: "integration",
  projectId: "project",
  agentId: "agent",
  taskId: "task",
  userId: "user",
  promptId: "prompt",
};

let contextResolver: LogContextResolver | null = null;

/** Install (or clear with `null`) the resolver used to add entity names to log records. */
export function setLogContextResolver(resolver: LogContextResolver | null): void {
  contextResolver = resolver;
}

function resolveSafely(resolver: LogContextResolver, kind: LogEntityKind, id: string): Readonly<Record<string, string>> | undefined {
  try {
    return resolver(kind, id);
  } catch {
    return undefined;
  }
}

/**
 * Insert readable context (names, ticket IDs) right after the matching ID
 * fields. Fields already present on the record win; lookup failures never
 * break logging.
 */
export function enrichLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const resolver = contextResolver;
  if (!resolver) return fields;
  const result: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in result)) result[key] = value;
    const kind = ENRICHED_ID_FIELDS[key];
    if (!kind || typeof value !== "string" || value === "") continue;
    if (kind === "project" && result["projectName"] !== undefined) continue;
    const context = resolveSafely(resolver, kind, value);
    if (!context) continue;
    for (const [extraKey, extraValue] of Object.entries(context)) {
      if (
        kind === "task" &&
        (extraKey === "projectId" || extraKey === "projectName") &&
        typeof fields["projectId"] === "string" &&
        fields["projectId"] !== context["projectId"]
      ) continue;
      if (extraKey in fields || extraKey in result) continue;
      result[extraKey] = extraValue;
      changed = true;
      // Context may introduce a new ID (e.g. a task's projectId); resolve it too.
      const nestedKind = ENRICHED_ID_FIELDS[extraKey];
      if (!nestedKind || nestedKind === kind) continue;
      if (nestedKind === "project" && (context["projectName"] || fields["projectName"])) continue;
      for (const [nestedKey, nestedValue] of Object.entries(resolveSafely(resolver, nestedKind, extraValue) ?? {})) {
        if (!(nestedKey in fields) && !(nestedKey in result)) result[nestedKey] = nestedValue;
      }
    }
  }
  return changed ? result : fields;
}

/** Initialise (or return) the singleton root Pino logger, configuring transport based on `NODE_ENV`. */
function getRoot(): pino.Logger {
  if (!rootLogger) {
    const isDev = process.env["NODE_ENV"] !== "production";
    const isTest = process.env["NODE_ENV"] === "test";
    const loggerConfig: pino.LoggerOptions = {
      // Keep test runs quiet unless a test explicitly opts into a log level.
      level: process.env["LOG_LEVEL"] ?? (isTest ? "silent" : "info"),
      base: { pid: process.pid },
      formatters: { log: enrichLogFields },
    };
    
    if (isDev) {
      loggerConfig.transport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      };
    }
    
    rootLogger = pino(loggerConfig);
  }
  return rootLogger;
}

/** Returns a child Pino logger tagged with `component` for structured log filtering. */
export function getLogger(component: string): pino.Logger {
  return getRoot().child({ component });
}
