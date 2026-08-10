/**
 * Application configuration.
 *
 * Loads environment variables (and an optional `.env` file), validates them
 * with Zod, and exposes a typed singleton via `getConfig()`. All env vars are
 * optional unless a provider-specific env-backed setup is partially configured
 * (completed via `superRefine`).
 */
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve } from "path";


const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

// ─── Load .env file if present ────────────────────────────────────────────────

/** Load key=value pairs from a `.env` file into `process.env`, skipping keys that are already set. */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional
  }
}

loadDotEnv();

// ─── Configuration schema ─────────────────────────────────────────────────────

const ConfigSchema = z.object({
    // Application
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    databasePath: z.string().default("./data/virtual-engineer.db"),
    adminApiEnabled: booleanFromEnv.default(true),
    adminApiHost: z.string().min(1).default("127.0.0.1"),
    adminApiPort: z.coerce.number().int().positive().default(3100),
    // An empty string (e.g. `ADMIN_AUTH_SECRET=` with no value) is treated as unset,
    // consistent with how other optional env vars behave, rather than failing the min-length check.
    adminAuthSecret: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .min(32, "ADMIN_AUTH_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32")
        .optional(),
    ),
    /**
     * When `true`, the admin auth layer extracts the client IP from the
     * `X-Forwarded-For` header (first entry) instead of the raw socket address.
     * Only enable this when the admin server sits behind a trusted reverse proxy
     * you control — blindly trusting the header in a publicly reachable
     * deployment lets clients spoof their IP and bypass rate-limiting.
     * Default: `false` (safe for the standard loopback-bound deployment).
     */
    adminTrustProxy: booleanFromEnv.default(false),

    // Workflow
    pollingIntervalMs: z.coerce.number().int().positive().default(30_000),
    maxAgentCycles: z.coerce.number().int().positive().default(3),
    maxRetryAttempts: z.coerce.number().int().positive().default(5),
    maxCommitsPerCycle: z.coerce.number().int().positive().default(10),
    agentTimeoutMs: z.coerce.number().int().positive().default(3_600_000),
    /** Max retry attempts for the ticket-close call in `closeTicket()` (network/API hiccups only). */
    ticketCloseMaxRetries: z.coerce.number().int().positive().default(5),
    /** Minimum backoff between ticket-close retries (ms). */
    ticketCloseRetryMinTimeoutMs: z.coerce.number().int().positive().default(5_000),
    /** Maximum diff characters injected into the review prompt (prevents token blow-ups). */
    maxReviewDiffChars: z.coerce.number().int().positive().default(60_000),
    /** Maximum number of inline comments VE posts per review pass (excess is folded into the summary). */
    maxReviewComments: z.coerce.number().int().positive().default(20),
    /** Maximum number of discussion-thread replies VE posts per review pass. */
    maxReviewReplies: z.coerce.number().int().positive().default(20),
    /** Minimum severity for an inline review comment to be posted; lower severities are folded into the summary. */
    reviewMinSeverity: z.enum(["nit", "info", "warning", "error"]).default("info"),

    // Docker
    agentContainerImage: z.string().default("virtual-engineer-workspace:latest"),
    workspaceBaseDir: z.string().default("/tmp/virtual-engineer/workspaces"),
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Map environment variables to the keys expected by `ConfigSchema`. */
function fromEnv(): Record<string, string | undefined> {
  return {
    nodeEnv: process.env["NODE_ENV"],
    logLevel: process.env["LOG_LEVEL"],
    databasePath: process.env["DATABASE_PATH"],
    adminApiEnabled: process.env["ADMIN_API_ENABLED"],
    adminApiHost: process.env["ADMIN_API_HOST"],
    adminApiPort: process.env["ADMIN_API_PORT"],
    adminAuthSecret: process.env["ADMIN_AUTH_SECRET"],
    adminTrustProxy: process.env["ADMIN_TRUST_PROXY"],
    pollingIntervalMs: process.env["POLLING_INTERVAL_MS"],
    maxAgentCycles: process.env["MAX_AGENT_CYCLES"],
    maxRetryAttempts: process.env["MAX_RETRY_ATTEMPTS"],
    maxCommitsPerCycle: process.env["MAX_COMMITS_PER_CYCLE"],
    agentTimeoutMs: process.env["AGENT_TIMEOUT_MS"],
    ticketCloseMaxRetries: process.env["TICKET_CLOSE_MAX_RETRIES"],
    ticketCloseRetryMinTimeoutMs: process.env["TICKET_CLOSE_RETRY_MIN_TIMEOUT_MS"],
    maxReviewDiffChars: process.env["MAX_REVIEW_DIFF_CHARS"],
    maxReviewComments: process.env["MAX_REVIEW_COMMENTS"],
    maxReviewReplies: process.env["MAX_REVIEW_REPLIES"],
    reviewMinSeverity: process.env["REVIEW_MIN_SEVERITY"],
    agentContainerImage: process.env["AGENT_CONTAINER_IMAGE"],
    workspaceBaseDir: process.env["WORKSPACE_BASE_DIR"],
  };
}

let _config: AppConfig | null = null;

/** Parse and validate configuration from environment variables. Throws on invalid config. */
export function getConfig(): AppConfig {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(fromEnv());
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  _config = result.data;
  return _config;
}

/** Reset config cache — use in tests only */
export function resetConfig(): void {
  _config = null;
}
