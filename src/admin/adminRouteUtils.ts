import type { IncomingMessage, ServerResponse } from "node:http";

export const SECRET_MASK = "********";

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
