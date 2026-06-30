/**
 * GerritHttpClient — shared HTTP transport for Gerrit REST API.
 *
 * Handles Authorization: Basic header injection and the ")]}'\n" XSS
 * protection prefix that Gerrit prepends to every REST response body.
 * All authenticated endpoints are served under the /a/ path prefix.
 */
import { getLogger } from "../logger.js";

const log = getLogger("gerrit-http-client");

export const HTTP_TIMEOUT_MS = 30_000;

/**
 * Error thrown when a Gerrit REST API request returns a non-2xx status code.
 */
export class GerritHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`Gerrit HTTP ${statusCode} for ${url}: ${body.slice(0, 200)}`);
    this.name = "GerritHttpError";
  }
}

export interface GerritHttpClientConfig {
  /** Gerrit base URL, e.g. https://gerrit.example.com */
  baseUrl: string;
  /** Gerrit HTTP username (same as SSH user by convention) */
  username: string;
  /** Gerrit HTTP password or generated token */
  token: string;
}

/**
 * GerritHttpClient — thin wrapper around `fetch` for the Gerrit REST API.
 *
 * All requests go to `<baseUrl>/a/<path>` with an `Authorization: Basic`
 * header computed from `username:token`.  Gerrit's ")]}'\n" XSS prefix is
 * stripped automatically before JSON parsing.
 */
export class GerritHttpClient {
  private readonly authHeader: string;
  /** Authenticated REST API base, e.g. https://gerrit.example.com/a */
  private readonly apiBase: string;

  constructor(private readonly config: GerritHttpClientConfig) {
    const encoded = Buffer.from(`${config.username}:${config.token}`).toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.apiBase = config.baseUrl.replace(/\/$/, "") + "/a";
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get username(): string {
    return this.config.username;
  }

  /**
   * Build the HTTPS clone URL for a repository, with credentials embedded.
   * Git credential helpers are not needed in the container when the URL
   * already carries user:token — but the URL must be redacted in logs.
   */
  buildCloneUrl(repoPath: string): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    // Strip protocol so we can embed user:token
    const withoutProtocol = base.replace(/^https?:\/\//, "");
    const cleanPath = repoPath.replace(/^\//, "");
    return `https://${this.config.username}:${this.config.token}@${withoutProtocol}/${cleanPath}`;
  }

  /** Fetch and parse a JSON response from the Gerrit REST API. */
  async fetchJson<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const url = `${this.apiBase}/${path.replace(/^\//, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GerritHttpError(response.status, url, body);
    }

    const text = await response.text();
    // Gerrit prepends ")]}'\n" to all REST responses to prevent XSSI
    const json = text.startsWith(")]}'\n") ? text.slice(5) : text;
    log.debug({ url, statusCode: response.status }, "Gerrit HTTP response received");
    return JSON.parse(json) as T;
  }

  /**
   * Issue a Gerrit REST API request where the response body is intentionally
   * ignored (e.g. DELETE operations).
   */
  async fetchVoid(path: string, init?: RequestInit): Promise<void> {
    const url = `${this.apiBase}/${path.replace(/^\//, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GerritHttpError(response.status, url, body);
    }
    await response.text();
  }

  /**
   * Build a streaming fetch request for the Gerrit SSE events endpoint.
   * Returns the raw Response so the caller can consume the body as a stream.
   * No timeout is applied — the caller is responsible for lifecycle management.
   */
  async fetchStream(path: string, signal: AbortSignal): Promise<Response> {
    const url = `${this.apiBase}/${path.replace(/^\//, "")}`;
    const response = await globalThis.fetch(url, {
      signal,
      headers: {
        Authorization: this.authHeader,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GerritHttpError(response.status, url, body);
    }
    return response;
  }
}
