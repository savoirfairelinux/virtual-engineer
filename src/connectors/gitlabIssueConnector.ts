/**
 * GitLab Issues connector — implements `TicketConnector` using the GitLab REST API.
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
import { GitLabHttpClient } from "./gitlabHttpClient.js";
import { getLogger } from "../logger.js";

const log = getLogger("gitlab-issue-connector");

// ─── Zod schemas for GitLab REST API responses ────────────────────────────────

const GitLabUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
});

const GitLabIssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable().default(""),
  state: z.string(),
  assignee: z
    .object({ id: z.number(), name: z.string(), username: z.string() })
    .nullable()
    .optional(),
  project_id: z.number(),
  labels: z.array(z.string()).default([]),
  web_url: z.string(),
});

const GitLabIssuesResponseSchema = z.array(GitLabIssueSchema);

const GitLabProjectSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  path_with_namespace: z.string(),
  web_url: z.string(),
});

const GitLabProjectsResponseSchema = z.array(GitLabProjectSummarySchema);

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GitLabIssueConnectorConfig {
  baseUrl: string;
  projectId: string | number;
  token: string;
  /** Status ID treated as "closed" for transitionStatus — defaults to 0 (closed) */
  closedStatusId?: number;
  /** Status ID treated as "in-progress" label transition — defaults to 1 */
  inProgressStatusId?: number;
  /** Status ID treated as "in-review" label transition — defaults to 2 */
  inReviewStatusId?: number;
  /** Label name applied when status transitions to "in progress" */
  inProgressLabel?: string;
  /** Label name applied when status transitions to "in review" */
  inReviewLabel?: string;
}

export const DEFAULT_GITLAB_IN_PROGRESS_LABEL = "in-progress";
export const DEFAULT_GITLAB_IN_REVIEW_LABEL = "in-review";

// ─── Connector implementation ─────────────────────────────────────────────────

export class GitLabIssueConnector extends AbstractTicketConnector implements TicketConnector {
  private readonly closedStatusId: number;
  protected readonly inProgressStatusId: number;
  protected readonly inReviewStatusId: number;
  private readonly inProgressLabel: string;
  private readonly inReviewLabel: string;
  private readonly http: GitLabHttpClient;

  constructor(private readonly config: GitLabIssueConnectorConfig) {
    super();
    this.closedStatusId = config.closedStatusId ?? 0;
    this.inProgressStatusId = config.inProgressStatusId ?? 1;
    this.inReviewStatusId = config.inReviewStatusId ?? 2;
    this.inProgressLabel = config.inProgressLabel ?? DEFAULT_GITLAB_IN_PROGRESS_LABEL;
    this.inReviewLabel = config.inReviewLabel ?? DEFAULT_GITLAB_IN_REVIEW_LABEL;
    this.http = new GitLabHttpClient(config.token, createGitLabError);
  }

  /** Fetch all open GitLab issues assigned to the authenticated user. */
  async getAssignedTickets(opts?: AssignedTicketQueryOptions): Promise<Ticket[]> {
    const user = await this.http.fetchJson<z.infer<typeof GitLabUserSchema>>(
      `${this.config.baseUrl}/api/v4/user`
    );
    GitLabUserSchema.parse(user);

    const url = new URL(this.buildProjectApiUrl("issues", opts?.projectKey));
    url.searchParams.set("assignee_id", String(user.id));
    url.searchParams.set("state", "opened");
    url.searchParams.set("per_page", "100");

    const issues = GitLabIssuesResponseSchema.parse(
      await this.http.fetchJson(url.toString())
    );

    log.debug({ count: issues.length }, "fetched assigned GitLab issues");
    return issues.map((i) => this.mapIssue(i));
  }

  /** Fetch a single GitLab issue by its IID. */
  async getTicket(ticketId: TicketId): Promise<Ticket> {
    const issue = GitLabIssueSchema.parse(
      await this.http.fetchJson(this.buildProjectApiUrl(`issues/${ticketId}`))
    );
    return this.mapIssue(issue);
  }

  /** Transition a GitLab issue to a new workflow state via state_event or label update. */
  async transitionStatus(ticketId: TicketId, targetStatusId: number): Promise<void> {
    if (targetStatusId === this.closedStatusId) {
      // Closing must also strip the workflow labels (status::* legacy pattern + the
      // configured in-progress/in-review labels) — otherwise a closed issue is left
      // stuck showing "in review" forever.
      const issue = GitLabIssueSchema.parse(
        await this.http.fetchJson(this.buildProjectApiUrl(`issues/${ticketId}`))
      );
      const configuredLabels = new Set([this.inProgressLabel, this.inReviewLabel]);
      const cleanedLabels = issue.labels.filter(
        (l) => !l.startsWith("status::") && !configuredLabels.has(l)
      );
      await this.http.fetchJsonVoid(this.buildProjectApiUrl(`issues/${ticketId}`), {
        method: "PUT",
        body: JSON.stringify({ state_event: "close", labels: cleanedLabels.join(",") }),
      });
      log.info({ ticketId, targetStatusId }, "closed GitLab issue via state transition");
      return;
    }

    // For non-close transitions, update labels to track workflow state
    const labelMap: Record<number, string> = {
      [this.inProgressStatusId]: this.inProgressLabel,
      [this.inReviewStatusId]: this.inReviewLabel,
    };
    const newLabel = labelMap[targetStatusId];
    if (!newLabel) {
      log.debug({ ticketId, targetStatusId }, "no label mapping for status ID, skipping");
      return;
    }

    // Fetch current labels and replace the status:: label
    const issue = GitLabIssueSchema.parse(
      await this.http.fetchJson(this.buildProjectApiUrl(`issues/${ticketId}`))
    );
    // Remove status labels: legacy status::* pattern + both configured workflow labels
    const configuredLabels = new Set([this.inProgressLabel, this.inReviewLabel]);
    // Early exit: skip PUT if issue already has the target label and nothing to clean up
    const needsCleanup = issue.labels.some(
      (l) => l.startsWith("status::") || (configuredLabels.has(l) && l !== newLabel)
    );
    if (issue.labels.includes(newLabel) && !needsCleanup) {
      log.debug({ ticketId, label: newLabel }, "label already set, skipping PUT");
      return;
    }
    const existingLabels = issue.labels.filter(
      (l) => !l.startsWith("status::") && !configuredLabels.has(l)
    );
    const updatedLabels = [...existingLabels, newLabel];

    await this.http.fetchJsonVoid(this.buildProjectApiUrl(`issues/${ticketId}`), {
      method: "PUT",
      body: JSON.stringify({ labels: updatedLabels.join(",") }),
    });
    log.info({ ticketId, label: newLabel }, "updated GitLab issue workflow label");
  }

  /** Add a note (comment) to a GitLab issue, optionally marking it confidential. */
  async addNote(ticketId: TicketId, note: string, isPrivate = false): Promise<void> {
    await this.http.fetchJsonVoid(this.buildProjectApiUrl(`issues/${ticketId}/notes`), {
      method: "POST",
      body: JSON.stringify({ body: note, confidential: isPrivate }),
    });
    log.info({ ticketId }, "added note to GitLab issue");
  }

  /** Add a closing note and transition the issue to the closed state. */
  async closeTicket(ticketId: TicketId, closingNote: string): Promise<void> {
    await this.addNote(ticketId, closingNote);
    await this.transitionStatus(ticketId, this.closedStatusId);
    log.info({ ticketId }, "closed GitLab issue");
  }

  /**
   * Discovery: list every GitLab project the current token has membership on.
   * Paginates via the `?page=N` query parameter (driven by GitLab's
   * `X-Next-Page` response header).
   */
  async listProjects(): Promise<DiscoveredTicketProject[]> {
    const all: DiscoveredTicketProject[] = [];
    let page = 1;

    while (true) {
      const url = new URL(`${this.config.baseUrl}/api/v4/projects`);
      url.searchParams.set("membership", "true");
      url.searchParams.set("simple", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const { body, nextPage } = await this.http.fetchPaginated(url.toString());
      const projects = GitLabProjectsResponseSchema.parse(body);

      for (const project of projects) {
        all.push({
          key: project.path_with_namespace,
          name: project.name,
          url: project.web_url,
        });
      }

      if (!nextPage) break;
      page = nextPage;
    }

    log.debug({ count: all.length }, "discovered GitLab projects");
    return all;
  }

  /** Build the full GitLab REST API URL for a project-scoped resource path. */
  private buildProjectApiUrl(path: string, overrideProjectKey?: string): string {
    const project = overrideProjectKey ?? String(this.config.projectId);
    return `${this.config.baseUrl}/api/v4/projects/${this.encodeProjectKey(project)}/${path}`;
  }

  /** Percent-encode a project key or path-with-namespace for use in API URLs. */
  private encodeProjectKey(projectId: string): string {
    try {
      return encodeURIComponent(decodeURIComponent(projectId));
    } catch {
      return encodeURIComponent(projectId);
    }
  }

  /** Map a raw GitLab issue API object to the canonical Ticket shape. */
  private mapIssue(i: z.infer<typeof GitLabIssueSchema>): Ticket {
    const customFields: Record<string, string> = {};
    for (const label of i.labels) {
      customFields[label] = label;
    }
    return {
      id: makeTicketId(String(i.iid)),
      subject: i.title,
      description: i.description ?? "",
      status: i.state,
      assigneeId: i.assignee?.id ?? 0,
      projectId: i.project_id,
      customFields,
      webUrl: i.web_url,
    };
  }

  /** Return the source label used to identify this connector in logs and DB records. */
  getSourceLabel(): string {
    return "gitlab";
  }
}

export class GitLabApiError extends TicketApiError {
  constructor(
    statusCode: number,
    url: string,
    body: string
  ) {
    super(statusCode, url, body);
    this.name = "GitLabApiError";
  }
}

export class GitLabNotFoundError extends TicketNotFoundError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "GitLabNotFoundError";
  }
}

/** Create a typed GitLab API error, using GitLabNotFoundError for 404 responses. */
function createGitLabError(statusCode: number, url: string, body: string): TicketApiError {
  if (statusCode === 404) {
    return new GitLabNotFoundError(statusCode, url, body);
  }
  return new GitLabApiError(statusCode, url, body);
}
