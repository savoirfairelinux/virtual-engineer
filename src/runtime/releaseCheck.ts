import { getLogger } from "../logger.js";
import { isReleaseVersion } from "./updateHandshake.js";

const log = getLogger("release-check");

/** Same source as `scripts/update.sh` (VE_RELEASES_API). */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/savoirfairelinux/virtual-engineer/releases/latest";
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt: string | undefined;
}

export interface ReleaseCheckResult {
  release: ReleaseInfo | null;
  error: string | null;
  /** Milliseconds since epoch. */
  checkedAt: number;
}

export interface ReleaseChecker {
  /** Latest published release, cached; `refresh` bypasses the cache. */
  latest(options?: { refresh?: boolean }): Promise<ReleaseCheckResult>;
}

export interface ReleaseCheckerOptions {
  fetch?: typeof fetch;
  url?: string;
  now?: () => number;
}

function parseRelease(body: unknown): ReleaseInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const { tag_name: tag, html_url: url, published_at: publishedAt } = body as Record<string, unknown>;
  if (typeof tag !== "string") return null;
  const version = tag.replace(/^v/, "");
  if (!isReleaseVersion(version) || typeof url !== "string" || !url.startsWith("https://github.com/")) return null;
  return { version, url, publishedAt: typeof publishedAt === "string" ? publishedAt : undefined };
}

export function createReleaseChecker(options: ReleaseCheckerOptions = {}): ReleaseChecker {
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? LATEST_RELEASE_URL;
  const now = options.now ?? Date.now;
  let cached: ReleaseCheckResult | undefined;
  let inFlight: Promise<ReleaseCheckResult> | undefined;

  async function check(): Promise<ReleaseCheckResult> {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "virtual-engineer" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`release check returned HTTP ${response.status}`);
      const release = parseRelease(await response.json());
      if (release === null) throw new Error("release check returned an unexpected payload");
      return { release, error: null, checkedAt: now() };
    } catch (err: unknown) {
      log.warn({ err }, "could not check for a newer release");
      return {
        release: cached?.release ?? null,
        error: "Could not reach GitHub to check for releases.",
        checkedAt: now(),
      };
    }
  }

  return {
    async latest({ refresh = false } = {}): Promise<ReleaseCheckResult> {
      if (!refresh && cached !== undefined) {
        const ttl = cached.error === null ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
        if (now() - cached.checkedAt < ttl) return cached;
      }
      inFlight ??= check().then((result) => {
        cached = result;
        return result;
      }).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
