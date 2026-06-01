import { z } from "zod";
import type { TicketConnector, Ticket, TicketId, AssignedTicketQueryOptions } from "../interfaces.js";
import { makeTicketId } from "../interfaces.js";
import { AbstractTicketConnector } from "./baseTicketConnector.js";
import { getLogger } from "../logger.js";

const log = getLogger("github-issue-connector");

// ─── Zod schemas for GitHub REST API responses ────────────────────────────────

const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().default(""),
  state: z.string(),
  assignee: z
    .object({ id: z.number(), login: z.string() })
    .nullable()
    .optional(),
  labels: z.array(
    z.union([
      z.string(),
      z.object({ name: z.string() }),
    ])
  ).default([]),
  html_url: z.string(),
  pull_request: z.object({}).optional(),
});

const GitHubIssuesResponseSchema = z.array(GitHubIssueSchema);

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GitHubIssueConnectorConfig {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  token: string;
  inProgressLabel?: string;
  virtualEngineerUserLogin?: string | undefined;
}

// ─── Connector implementation ─────────────────────────────────────────────────

export class GitHubIssueConnector extends AbstractTicketConnector implements TicketConnector {
  protected readonly inProgressStatusId = 1;
  protected readonly inReviewStatusId = 2;
  private readonly inProgressLabel: string;

  constructor(private readonly config: GitHubIssueConnectorConfig) {
    super();
    this.inProgressLabel = config.inProgressLabel ?? "in-progress";
  }

  async getAssignedTickets(_opts?: AssignedTicketQueryOptions): Promise<Ticket[]> {
    const login = await this.resolveUserLogin();
    const baseUrl = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues`;
    const PER_PAGE = 100;
    const MAX_PAGES = 5;

    const allIssues: z.infer<typeof GitHubIssuesResponseSchema> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(baseUrl);
      url.searchParams.set("state", "open");
      url.searchParams.set("assignee", login);
      url.searchParams.set("per_page", String(PER_PAGE));
      url.searchParams.set("page", String(page));

      const batch = GitHubIssuesResponseSchema.parse(await this.fetchJson(url.toString()));
      allIssues.push(...batch);
      if (batch.length < PER_PAGE) break;
    }

    // Filter out pull requests (GitHub returns PRs in issue endpoints)
    const filteredIssues = allIssues.filter((i) => !i.pull_request);

    log.debug({ login, count: filteredIssues.length }, "fetched open GitHub issues assigned to VE account");
    return filteredIssues.map((i) => this.mapIssue(i));
  }

  async getTicket(ticketId: TicketId): Promise<Ticket> {
    const issue = GitHubIssueSchema.parse(
      await this.fetchJson(
        `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}`
      )
    );
    return this.mapIssue(issue);
  }

  async transitionStatus(ticketId: TicketId, targetStatusId: number): Promise<void> {
    // Status 0 = close
    if (targetStatusId === 0) {
      await this.fetchJsonVoid(
        `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        }
      );
      log.info({ ticketId }, "closed GitHub issue");
      return;
    }

    // Status 1 = in-progress: add in-progress label + assign
    if (targetStatusId === 1) {
      await this.addLabel(ticketId, this.inProgressLabel);
      if (this.config.virtualEngineerUserLogin) {
        await this.assignUser(ticketId, this.config.virtualEngineerUserLogin);
      }
      log.info({ ticketId }, "claimed GitHub issue (in-progress)");
      return;
    }

    log.debug({ ticketId, targetStatusId }, "no mapping for status ID, skipping");
  }

  async addNote(ticketId: TicketId, note: string, _isPrivate = false): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: note }),
      }
    );
    log.info({ ticketId }, "added comment to GitHub issue");
  }

  async closeTicket(ticketId: TicketId, closingNote: string): Promise<void> {
    await this.addNote(ticketId, closingNote);
    await this.transitionStatus(ticketId, 0);
    log.info({ ticketId }, "closed GitHub issue");
  }

  getSourceLabel(): string {
    return "github-issue";
  }

  // ─── Public ticket-connector-specific methods ──────────────────────────────

  async claimTicket(ticketId: TicketId): Promise<void> {
    await this.transitionStatus(ticketId, 1);
  }

  async releaseTicket(ticketId: TicketId): Promise<void> {
    await this.removeLabel(ticketId, this.inProgressLabel);
    if (this.config.virtualEngineerUserLogin) {
      await this.unassignUser(ticketId, this.config.virtualEngineerUserLogin);
    }
    log.info({ ticketId }, "released GitHub issue");
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async addLabel(ticketId: TicketId, label: string): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      }
    );
  }

  private async removeLabel(ticketId: TicketId, label: string): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" }
    );
  }

  private async assignUser(ticketId: TicketId, login: string): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}/assignees`,
      {
        method: "POST",
        body: JSON.stringify({ assignees: [login] }),
      }
    );
  }

  private async unassignUser(ticketId: TicketId, login: string): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${ticketId}/assignees`,
      {
        method: "DELETE",
        body: JSON.stringify({ assignees: [login] }),
      }
    );
  }

  /**
   * Returns the GitHub login of the authenticated account.
   * Uses `virtualEngineerUserLogin` from config if set; otherwise calls GET /user
   * once and caches the result for the lifetime of this connector instance.
   */
  private loginPromise: Promise<string> | undefined;
  private async resolveUserLogin(): Promise<string> {
    if (this.config.virtualEngineerUserLogin) return this.config.virtualEngineerUserLogin;
    this.loginPromise ??= this.fetchJson<{ login: string }>(`${this.config.apiBaseUrl}/user`)
      .then((user) => {
        if (typeof user.login !== "string" || !user.login) {
          throw new Error("GitHub /user response missing expected 'login' field");
        }
        return user.login;
      });
    return this.loginPromise;
  }

  private async fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubApiError(response.status, url, body);
    }

    return response.json() as Promise<T>;
  }

  private async fetchJsonVoid(url: string, init?: RequestInit): Promise<void> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubApiError(response.status, url, body);
    }

    await response.text();
  }

  private mapIssue(i: z.infer<typeof GitHubIssueSchema>): Ticket {
    const customFields: Record<string, string> = {};
    for (const label of i.labels) {
      const name = typeof label === "string" ? label : label.name;
      customFields[name] = name;
    }
    return {
      id: makeTicketId(String(i.number)),
      subject: i.title,
      description: i.body ?? "",
      status: i.state,
      assigneeId: i.assignee?.id ?? 0,
      projectId: 0,
      customFields,
      webUrl: i.html_url,
    };
  }
}

export class GitHubApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`GitHub API error ${statusCode} on ${url}: ${body}`);
    this.name = "GitHubApiError";
  }
}
