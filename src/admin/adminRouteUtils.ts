import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

export const SECRET_MASK = "********";

/**
 * Convert a dotted/array path from a Zod issue into a human-readable label.
 * Examples:
 *   "agentId"                -> "Agent"
 *   "ticketSource.integrationId" -> "Ticket source › Integration"
 *   "pushTargets.0.repoKey"  -> "Push target #1 › Repository"
 */
function humanizeFieldPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "";
  const friendly: Record<string, string> = {
    agentId: "Agent",
    name: "Name",
    type: "Type",
    integrationId: "Integration",
    ticketProjectKey: "Ticket project",
    repoKey: "Repository",
    cloneUrl: "Clone URL",
    targetBranch: "Target branch",
    localPath: "Local path",
    sshKeyPath: "SSH key path",
    commitOrder: "Commit order",
    role: "Role",
    pushTargets: "Push targets",
    ticketSource: "Ticket source",
    reviewConfig: "Review config",
    repoKeys: "Repositories",
    modelConfig: "Model config",
    maxConcurrent: "Max concurrent",
    systemPromptId: "System prompt",
    instructionsPromptId: "Instructions prompt",
    postCloneScript: "Post-clone script",
    agentOverrideJson: "Agent override (JSON)",
    enabled: "Enabled",
    baseUrl: "Base URL",
    clientId: "Client ID",
    clientSecret: "Client secret",
    personalAccessToken: "Personal access token",
    apiToken: "API token",
    sessionToken: "Session token",
    model: "Model",
    webhookSecret: "Webhook secret",
  };
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment === "number") {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? "Item"} #${segment + 1}`;
      continue;
    }
    if (segment === undefined) continue;
    parts.push(friendly[segment] ?? segment);
  }
  return parts.join(" › ");
}

/**
 * Format a ZodError into a single human-readable summary string, e.g.
 *   "Agent is required — create and enable a coding agent first (Agents tab); Name: required"
 * Issues with the same field message are de-duplicated.
 */
export function formatZodError(error: z.ZodError, fallback = "Invalid payload"): string {
  const issues = error.issues;
  if (!issues || issues.length === 0) return fallback;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of issues) {
    const label = humanizeFieldPath(issue.path);
    const message = issue.message && issue.message.trim().length > 0
      ? issue.message
      : "is invalid";
    // If the message itself already mentions the field (or there's no field), just use the message.
    const text = !label || message.toLowerCase().includes(label.toLowerCase())
      ? message
      : `${label}: ${message}`;
    if (!seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }
  return parts.join("; ");
}

/**
 * Build a JSON error body for a failed Zod validation. The top-level `error`
 * field is a human-readable summary listing the offending fields (so UIs
 * that only display `error` still surface the actual problem). The
 * machine-readable `details` field is retained for programmatic clients.
 */
export function zodErrorBody(
  error: z.ZodError,
  fallback = "Invalid payload"
): { error: string; details: ReturnType<z.ZodError["flatten"]> } {
  return {
    error: formatZodError(error, fallback),
    details: error.flatten(),
  };
}

// ⚠️ SECURITY: Limit request body to 512 KB to prevent memory exhaustion attacks.
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

/** Write a JSON response with the given status code. */
export function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

/** Write an HTML response with the given status code. */
export function writeHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

/** Read and parse the request body as JSON, returning null on error or when body exceeds MAX_BODY_BYTES. */
export async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // ⚠️ SECURITY: Destroy the request socket immediately to terminate the connection
        // and prevent further data transmission.
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve(null); return; }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

/** Cast an unknown value to a plain object record; returns an empty object for non-objects. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Parse a JSON string into a config record; returns an empty object on any failure. */
export function parseConfig(json: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return {};
  }
}

/** Normalize a legacy timestamp value (Date | string | number) to an ISO-8601 string. */
export function toIsoTimestamp(value: Date | string | number): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  }

  if (typeof value === "number") {
    const millis = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  const numericValue = Number(value);
  if (!Number.isNaN(numericValue) && value.trim() !== "") {
    return toIsoTimestamp(numericValue);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}
