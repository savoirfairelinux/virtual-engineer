/**
 * Shared HTTP helper for GitLab connectors.
 *
 * Provides `fetchJson`, `fetchJsonVoid`, and `fetchPaginated` with automatic
 * `Authorization: Bearer` injection and error translation via a caller-supplied
 * `errorFactory`.  Both `GitLabIssueConnector` and
 * `GitLabMergeRequestConnector` hold an instance of this class.
 */
import type { ApiHttpError } from "../interfaces.js";
import { buildGitLabApiHeaders } from "../utils/gitlabAuth.js";

export const DISCOVERY_TIMEOUT_MS = 30_000;

export class GitLabHttpClient {
  constructor(
    private readonly token: string,
    private readonly errorFactory: (
      statusCode: number,
      url: string,
      body: string
    ) => ApiHttpError
  ) {}

  /** Fetch a JSON response from the GitLab API, throwing on non-2xx status. */
  async fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: buildGitLabApiHeaders(this.token, init?.headers),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.errorFactory(response.status, url, body);
    }

    return response.json() as Promise<T>;
  }

  /** Issue a GitLab API request where the response body is intentionally ignored. */
  async fetchJsonVoid(url: string, init?: RequestInit): Promise<void> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: buildGitLabApiHeaders(this.token, init?.headers),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw this.errorFactory(response.status, url, body);
    }

    await response.text();
  }

  /** Fetch one page from a paginated GitLab endpoint, returning the body and the next page number. */
  async fetchPaginated(url: string): Promise<{ body: unknown; nextPage: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      const response = await globalThis.fetch(url, {
        headers: buildGitLabApiHeaders(this.token),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw this.errorFactory(response.status, url, body);
      }
      const next = response.headers.get("x-next-page");
      const nextPage = next && next.trim().length > 0 ? Number(next) : null;
      const json = await response.json();
      return {
        body: json,
        nextPage: Number.isFinite(nextPage) && (nextPage as number) > 0 ? nextPage : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
