import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * File handshake with the host updater (`scripts/update.sh`), next to the
 * database. The orchestrator only writes requests; the host performs the
 * update because replacing the container needs host access the orchestrator
 * must not have. Keep file names and keys in sync with scripts/update-lib.sh.
 */
export const UPDATE_REQUEST_FILE = "update.request";
export const UPDATE_STATUS_FILE = "update.status";
export const UPDATER_INSTALLED_FILE = "updater.installed";

export const UPDATE_STATES = [
  "preparing",
  "draining",
  "starting",
  "verifying",
  "rolling_back",
  "succeeded",
  "failed",
  "rolled_back",
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

const ACTIVE_UPDATE_STATES: ReadonlySet<UpdateState> = new Set([
  "preparing", "draining", "starting", "verifying", "rolling_back",
]);

/** An active status older than this is treated as abandoned (the updater was killed). */
export const STALE_UPDATE_STATUS_SECONDS = 6 * 60 * 60;

export interface UpdateStatus {
  state: UpdateState;
  from: string | undefined;
  to: string | undefined;
  message: string;
  /** Seconds since epoch. */
  updatedAt: number;
}

export interface UpdateRequest {
  version: string;
  requestedBy: string;
  /** Seconds since epoch. */
  requestedAt: number;
}

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION.test(value);
}

/** Numeric X.Y.Z comparison; negative when `a` is older than `b`. */
export function compareReleaseVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isUpdateInProgress(
  request: UpdateRequest | undefined,
  status: UpdateStatus | undefined,
  nowSeconds: number,
): boolean {
  if (request !== undefined) return true;
  return status !== undefined
    && ACTIVE_UPDATE_STATES.has(status.state)
    && nowSeconds - status.updatedAt < STALE_UPDATE_STATUS_SECONDS;
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!values.has(key)) values.set(key, line.slice(index + 1).replace(/\r$/, ""));
  }
  return values;
}

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function optionalVersion(value: string | undefined): string | undefined {
  return isReleaseVersion(value) ? value : undefined;
}

/** Keeps request files to a single safe line per key for the shell parser. */
function sanitizeActor(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class UpdateHandshakeStore {
  constructor(private readonly dataDir: string) {}

  async readStatus(): Promise<UpdateStatus | undefined> {
    const text = await this.readOptional(UPDATE_STATUS_FILE);
    if (text === undefined) return undefined;
    const values = parseKeyValues(text);
    const state = values.get("state");
    const updatedAt = parseSeconds(values.get("updated_at"));
    if (!UPDATE_STATES.includes(state as UpdateState) || updatedAt === undefined) return undefined;
    return {
      state: state as UpdateState,
      from: optionalVersion(values.get("from")),
      to: optionalVersion(values.get("to")),
      message: values.get("message") ?? "",
      updatedAt,
    };
  }

  async readRequest(): Promise<UpdateRequest | undefined> {
    const text = await this.readOptional(UPDATE_REQUEST_FILE);
    if (text === undefined) return undefined;
    const values = parseKeyValues(text);
    const version = values.get("version");
    if (!isReleaseVersion(version)) return undefined;
    return {
      version,
      requestedBy: values.get("requested_by") ?? "unknown",
      requestedAt: parseSeconds(values.get("requested_at")) ?? 0,
    };
  }

  async isUpdaterInstalled(): Promise<boolean> {
    return (await this.readOptional(UPDATER_INSTALLED_FILE)) !== undefined;
  }

  async writeRequest(input: { version: string; requestedBy: string; nowSeconds: number }): Promise<UpdateRequest> {
    if (!isReleaseVersion(input.version)) throw new Error("Invalid release version");
    const request: UpdateRequest = {
      version: input.version,
      requestedBy: sanitizeActor(input.requestedBy),
      requestedAt: Math.floor(input.nowSeconds),
    };
    await mkdir(this.dataDir, { recursive: true });
    const target = join(this.dataDir, UPDATE_REQUEST_FILE);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const body = [
      `version=${request.version}`,
      `requested_by=${request.requestedBy}`,
      `requested_at=${request.requestedAt}`,
      "",
    ].join("\n");
    try {
      await writeFile(temporary, body, { mode: 0o644, flag: "wx" });
      await rename(temporary, target);
    } catch (err: unknown) {
      await rm(temporary, { force: true });
      throw err;
    }
    return request;
  }

  private async readOptional(name: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.dataDir, name), "utf8");
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return undefined;
      throw err;
    }
  }
}
