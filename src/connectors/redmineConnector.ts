/**
 * Redmine REST API connector — implements `TicketConnector` using Redmine's JSON REST API.
 */
import { z } from "zod";
import type {
  AssignedTicketQueryOptions,
  DiscoveredTicketProject,
  TicketConnector,
  Ticket,
  TicketId,
} from "../interfaces.js";
import { makeTicketId, TicketApiError, TicketNotFoundError } from "../interfaces.js";
import { AbstractTicketConnector } from "./baseTicketConnector.js";
import { getLogger } from "../logger.js";

const log = getLogger("redmine-connector");

const DISCOVERY_TIMEOUT_MS = 30_000;

// ─── Zod schemas for Redmine REST API responses ───────────────────────────────

const RedmineCustomFieldSchema = z.object({
  id: z.number(),
  name: z.string(),
  value: z.string().optional(),
});

const RedmineIssueSchema = z.object({
  id: z.number(),
  subject: z.string(),
  description: z.string().default(""),
  status: z.object({ id: z.number(), name: z.string() }),
  assigned_to: z.object({ id: z.number(), name: z.string() }).optional(),
  project: z.object({ id: z.number(), name: z.string() }),
  custom_fields: z.array(RedmineCustomFieldSchema).default([]),
});

const RedmineIssuesResponseSchema = z.object({
  issues: z.array(RedmineIssueSchema),
  total_count: z.number(),
});

const RedmineIssueResponseSchema = z.object({
  issue: RedmineIssueSchema,
});

const RedmineProjectSchema = z.object({
  id: z.number(),
  identifier: z.string(),
  name: z.string(),
});

const RedmineProjectsResponseSchema = z.object({
  projects: z.array(RedmineProjectSchema),
  total_count: z.number(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

// ─── Connector implementation ─────────────────────────────────────────────────

export interface RedmineConnectorConfig {
  baseUrl: string;
  apiKey: string;
  virtualEngineerUserId: number;
  /** Status ID in Redmine that maps to "closed" */
  closedStatusId: number;
  /** Status ID in Redmine that maps to "in progress" */
  inProgressStatusId: number;
  /** Status ID in Redmine that maps to "in review" */
  inReviewStatusId: number;
}

/** HTTP-based Redmine connector. Uses `X-Redmine-API-Key` for auth. */
export class HttpRedmineConnector extends AbstractTicketConnector implements TicketConnector {
  /** @inheritdoc */
  protected get inProgressStatusId(): number { return this.config.inProgressStatusId; }
  /** @inheritdoc */
  protected get inReviewStatusId(): number { return this.config.inReviewStatusId; }

  constructor(private readonly config: RedmineConnectorConfig) { super(); }

  /** Fetch all open Redmine issues assigned to the configured virtual-engineer user. */
  async getAssignedTickets(opts?: AssignedTicketQueryOptions): Promise<Ticket[]> {
    const url = new URL(`${this.config.baseUrl}/issues.json`);
    url.searchParams.set("assigned_to_id", String(this.config.virtualEngineerUserId));
    url.searchParams.set("status_id", "open");
    url.searchParams.set("limit", "50");
    if (opts?.projectKey) {
      // Redmine accepts identifier or numeric ID for project_id
      url.searchParams.set("project_id", opts.projectKey);
    }

    const response = await this.fetch(url.toString());
    const parsed = RedmineIssuesResponseSchema.parse(await response.json());

    log.debug({ count: parsed.issues.length }, "fetched assigned tickets");
    return parsed.issues.map((i) => this.mapIssue(i));
  }

  /** Fetch a single Redmine issue by its numeric ID. */
  async getTicket(ticketId: TicketId): Promise<Ticket> {
    const response = await this.fetch(
      `${this.config.baseUrl}/issues/${ticketId}.json`
    );
    const parsed = RedmineIssueResponseSchema.parse(await response.json());
    return this.mapIssue(parsed.issue);
  }

  /** Update the status of a Redmine issue via a PUT request. */
  async transitionStatus(ticketId: TicketId, targetStatusId: number): Promise<void> {
    await this.fetchJson(`${this.config.baseUrl}/issues/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        issue: { status_id: targetStatusId },
      }),
    });
    log.info({ ticketId, targetStatusId }, "transitioned Redmine ticket status");
  }

  /** Append a note (journal entry) to a Redmine issue, optionally as a private note. */
  async addNote(ticketId: TicketId, note: string, isPrivate = false): Promise<void> {
    await this.fetchJson(`${this.config.baseUrl}/issues/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        issue: {
          notes: note,
          private_notes: isPrivate,
        },
      }),
    });
    log.info({ ticketId }, "added note to Redmine ticket");
  }

  /** Set the Redmine issue status to closed and attach a closing note in one PUT request. */
  async closeTicket(ticketId: TicketId, closingNote: string): Promise<void> {
    await this.fetchJson(`${this.config.baseUrl}/issues/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        issue: {
          status_id: this.config.closedStatusId,
          notes: closingNote,
        },
      }),
    });
    log.info({ ticketId }, "closed Redmine ticket");
  }

  /**
   * Discovery: list all Redmine projects accessible with the current API key.
   * Paginates via `offset` until `total_count` is reached.
   */
  async listProjects(): Promise<DiscoveredTicketProject[]> {
    const limit = 100;
    let offset = 0;
    const all: DiscoveredTicketProject[] = [];

    while (true) {
      const url = new URL(`${this.config.baseUrl}/projects.json`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetch(url.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const parsed = RedmineProjectsResponseSchema.parse(await response.json());

      for (const project of parsed.projects) {
        all.push({
          key: project.identifier,
          name: project.name,
          url: `${this.config.baseUrl}/projects/${project.identifier}`,
        });
      }

      offset += parsed.projects.length;
      if (parsed.projects.length === 0 || offset >= parsed.total_count) break;
    }

    log.debug({ count: all.length }, "discovered Redmine projects");
    return all;
  }

  /** Issue an authenticated HTTP request to the Redmine API, throwing a typed error on failure. */
  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: {
        "X-Redmine-API-Key": this.config.apiKey,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw createRedmineError(response.status, url, body);
    }

    return response;
  }

  /** fetch() wrapper that expects no body on 204 */
  private async fetchJson(url: string, init?: RequestInit): Promise<void> {
    const response = await this.fetch(url, init);
    // PUT returns 200 or 204 — consume body to avoid resource leaks
    await response.text();
  }

  /** Return the source label used to identify this connector in logs and DB records. */
  getSourceLabel(): string {
    return "redmine";
  }

  /** Map a raw Redmine issue API object to the canonical Ticket shape. */
  private mapIssue(
    i: z.infer<typeof RedmineIssueSchema>
  ): Ticket {
    const customFields: Record<string, string> = {};
    for (const cf of i.custom_fields) {
      if (cf.value !== undefined) {
        customFields[cf.name] = cf.value;
      }
    }
    return {
      id: makeTicketId(String(i.id)),
      subject: i.subject,
      description: i.description,
      status: i.status.name,
      assigneeId: i.assigned_to?.id ?? 0,
      projectId: i.project.id,
      customFields,
      webUrl: `${this.config.baseUrl}/issues/${i.id}`,
    };
  }
}

export class RedmineApiError extends TicketApiError {
  constructor(
    statusCode: number,
    url: string,
    body: string
  ) {
    super(statusCode, url, body);
    this.name = "RedmineApiError";
  }
}

export class RedmineNotFoundError extends TicketNotFoundError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "RedmineNotFoundError";
  }
}

/** Create a typed Redmine API error, using RedmineNotFoundError for 404 responses. */
function createRedmineError(statusCode: number, url: string, body: string): TicketApiError {
  if (statusCode === 404) {
    return new RedmineNotFoundError(statusCode, url, body);
  }

  return new RedmineApiError(statusCode, url, body);
}
