/**
 * Pino logger factory.
 *
 * Output is silent in `test` environments, pretty-printed in development,
 * and plain JSON in production. All modules should call `getLogger(component)`
 * rather than constructing their own Pino instance.
 */
import pino from "pino";

let rootLogger: pino.Logger | null = null;

/** Initialise (or return) the singleton root Pino logger, configuring transport based on `NODE_ENV`. */
function getRoot(): pino.Logger {
  if (!rootLogger) {
    const isDev = process.env["NODE_ENV"] !== "production";
    const isTest = process.env["NODE_ENV"] === "test";
    const loggerConfig: pino.LoggerOptions = {
      // Keep test runs quiet unless a test explicitly opts into a log level.
      level: process.env["LOG_LEVEL"] ?? (isTest ? "silent" : "info"),
      base: { pid: process.pid },
    };
    
    if (isDev) {
      loggerConfig.transport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss" },
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
