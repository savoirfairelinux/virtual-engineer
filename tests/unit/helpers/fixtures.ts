/**
 * Shared JSON fixtures for Gerrit, Redmine, and GitLab REST API responses.
 * Used across connector unit tests to avoid duplication.
 */

// ─── Gerrit fixtures ──────────────────────────────────────────────────────────

export const gerritChangeInfo = {
  id: "myproject~master~I8473b95934b5732ac55d26311a706c9c2bde9940",
  _number: 42,
  status: "NEW" as const,
  current_revision: "abc123",
  revisions: {
    abc123: { _number: 3 },
    def456: { _number: 2 },
    ghi789: { _number: 1 },
  },
};

export const gerritCommentsResponse = {
  "src/main.ts": [
    {
      id: "comment-1",
      author: { email: "reviewer@example.com" },
      message: "Please fix this",
      line: 10,
      unresolved: true,
      updated: "2026-04-01 10:00:00.000000000",
      patch_set: 3,
    },
    {
      id: "comment-2",
      author: { email: "reviewer@example.com" },
      message: "Resolved already",
      line: 20,
      unresolved: false,
      updated: "2026-04-01 09:00:00.000000000",
      patch_set: 2,
    },
  ],
  "/PATCHSET_LEVEL": [
    {
      id: "comment-3",
      author: { email: "bot@example.com" },
      message: "LGTM but check nit",
      unresolved: true,
      updated: "2026-04-01 11:00:00.000000000",
      patch_set: 3,
    },
  ],
};

export const gerritChangeInfoMerged = {
  ...gerritChangeInfo,
  status: "MERGED" as const,
};

export const gerritChangeInfoAbandoned = {
  ...gerritChangeInfo,
  status: "ABANDONED" as const,
};

// ─── Redmine fixtures ─────────────────────────────────────────────────────────

export const redmineIssue = {
  id: 101,
  subject: "Implement feature X",
  description: "Full description of feature X",
  status: { id: 1, name: "New" },
  assigned_to: { id: 5, name: "Virtual Engineer" },
  project: { id: 1, name: "my-project" },
  custom_fields: [
    { id: 1, name: "Gerrit-Change-Id", value: "myproject~master~I8473b95934b5732ac55d26311a706c9c2bde9940" },
    { id: 2, name: "Priority-Score", value: "high" },
  ],
};

export const redmineIssueNoAssignee = {
  ...redmineIssue,
  id: 102,
  assigned_to: undefined,
  custom_fields: [],
};

export const redmineIssuesListResponse = {
  issues: [redmineIssue],
  total_count: 1,
};

export const redmineIssueResponse = {
  issue: redmineIssue,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wraps Gerrit JSON response in the XSSI-prevention prefix `)]}'`.
 * The connector strips this prefix before parsing.
 */
export function wrapGerritJson(data: unknown): string {
  return ")]}'\n" + JSON.stringify(data);
}

/**
 * Creates a minimal fetch Response with a JSON body.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Creates a minimal fetch Response with a Gerrit-prefixed JSON body.
 */
export function gerritJsonResponse(data: unknown, status = 200): Response {
  return new Response(wrapGerritJson(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Creates a fetch Response representing an HTTP error.
 */
export function errorResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

// ─── GitLab fixtures ──────────────────────────────────────────────────────────

export const gitlabUser = {
  id: 42,
  username: "ve-bot",
  name: "Virtual Engineer Bot",
};

export const gitlabIssue = {
  iid: 7,
  title: "Add logging to service",
  description: "We need structured logging\n\n## AC\n- Use pino",
  state: "opened",
  assignee: { id: 42, name: "Virtual Engineer Bot", username: "ve-bot" },
  project_id: 12345,
  labels: ["backend", "status::in-progress"],
  web_url: "https://gitlab.example.com/group/project/-/issues/7",
};

export const gitlabIssueNoAssignee = {
  ...gitlabIssue,
  iid: 8,
  assignee: null,
};

export const gitlabIssuesListResponse = [gitlabIssue];

export const gitlabMr = {
  iid: 42,
  state: "opened",
  web_url: "https://gitlab.example.com/group/project/-/merge_requests/42",
  title: "Add logging to service",
  source_branch: "feature-task-abc",
};

export const gitlabMrMerged = { ...gitlabMr, state: "merged" };
export const gitlabMrClosed = { ...gitlabMr, state: "closed" };
export const gitlabMrLocked = { ...gitlabMr, state: "locked" };

export const gitlabDiscussionsResponse = [
  {
    id: "disc-1",
    individual_note: false,
    resolved: false,
    notes: [
      {
        id: 101,
        author: { id: 5, username: "reviewer" },
        body: "Please add error handling here",
        system: false,
        resolved: false,
        updated_at: "2026-04-07T10:00:00.000Z",
        position: { new_path: "src/service.ts", new_line: 42 },
      },
    ],
  },
  {
    id: "disc-2",
    individual_note: false,
    resolved: true,
    notes: [
      {
        id: 102,
        author: { id: 5, username: "reviewer" },
        body: "Good fix here",
        system: false,
        resolved: true,
        updated_at: "2026-04-07T09:00:00.000Z",
        position: { new_path: "src/other.ts", new_line: 10 },
      },
    ],
  },
  {
    id: "disc-3",
    individual_note: true,
    resolved: false,
    notes: [
      {
        id: 103,
        author: { id: 5, username: "reviewer" },
        body: "Overall LGTM",
        system: false,
        resolved: false,
        updated_at: "2026-04-07T11:00:00.000Z",
        position: undefined,
      },
    ],
  },
];
