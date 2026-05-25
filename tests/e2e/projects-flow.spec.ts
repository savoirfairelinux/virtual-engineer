import { test, expect, type Route } from "@playwright/test";

/**
 * Phase 3 E2E: validates the new Agents and Projects admin tabs.
 *
 * This test fully stubs the relevant `/api/admin/*` endpoints so it does not
 * depend on having a configured orchestrator backend. We rely on the dashboard
 * JavaScript (embedded in `src/admin/dashboard.ts`) to drive the UI.
 *
 * Reordering UX: we use up/down (↑ / ↓) buttons rather than drag-and-drop.
 */

interface AgentRow {
  id: string;
  name: string;
  type: "coding" | "review";
  enabled: boolean;
  maxConcurrent: number;
  model: string | null;
  integrationId: string | null;
  systemPromptId: string | null;
  instructionsPromptId: string | null;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
  modelConfig?: Record<string, unknown>;
}

interface PushTarget {
  integrationId: string;
  repoKey: string;
  cloneUrl: string;
  targetBranch: string;
  role: string;
  commitOrder: number;
  localPath: string;
  sshKeyPath?: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  type: "coding" | "review";
  agentId: string;
  agentName: string | null;
  enabled: boolean;
  pushTargetCount: number;
  createdAt: string;
  updatedAt: string;
  ticketSource: { integration: { id: string; name: string; type: string } | null; ticketProjectKey: string } | null;
  reviewConfig: { integration: { id: string; name: string; type: string } | null; repos: string[] } | null;
  pushTargets?: PushTarget[];
  agentOverrideJson?: string | null;
  postCloneScript?: string;
}

const STUB_INTEGRATIONS = [
  {
    id: "redmine-stub",
    type: "redmine",
    category: "ticketing",
    name: "Redmine Stub",
    enabled: true,
    active: true,
    config: { baseUrl: "http://redmine.example", apiKey: "********", virtualEngineerUserId: 7 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    discoveredResources: {
      ticketProjects: [
        { key: "PLATFORM", name: "Platform" },
        { key: "MOBILE", name: "Mobile" },
      ],
      discoveredAt: new Date().toISOString(),
    },
    discoverySupported: true,
  },
  {
    id: "gerrit-stub",
    type: "gerrit",
    category: "review",
    name: "Gerrit Stub",
    enabled: true,
    active: true,
    config: { baseUrl: "http://gerrit.example", httpUsername: "admin", httpPassword: "********" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    discoveredResources: {
      repositories: [
        { key: "platform/api", name: "platform/api", cloneUrlSsh: "ssh://gerrit.example:29418/platform/api", defaultBranch: "main" },
        { key: "platform/lib", name: "platform/lib", cloneUrlSsh: "ssh://gerrit.example:29418/platform/lib", defaultBranch: "main" },
      ],
      discoveredAt: new Date().toISOString(),
    },
    discoverySupported: true,
  },
];

test.describe("Phase 3 — Projects flow", () => {
  let agents: AgentRow[];
  let projects: ProjectRow[];

  test.beforeEach(async ({ page }) => {
    agents = [];
    projects = [];

    const json = (route: Route, body: unknown, status = 200): Promise<void> =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    // Integrations (read-only, with discovered resources)
    await page.route("**/api/admin/integrations", async (route) => {
      const method = route.request().method();
      if (method === "GET") return json(route, { integrations: STUB_INTEGRATIONS });
      return route.continue();
    });

    // Agents endpoints
    await page.route("**/api/admin/agents", async (route) => {
      const method = route.request().method();
      if (method === "GET") return json(route, { agents });
      if (method === "POST") {
        const payload = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
        const id = "agent-" + (agents.length + 1);
        const cfg = (payload["modelConfig"] as Record<string, unknown>) || {};
        const created: AgentRow = {
          id,
          name: String(payload["name"] || ""),
          type: (payload["type"] as "coding" | "review") || "coding",
          enabled: Boolean(payload["enabled"]),
          maxConcurrent: Number(payload["maxConcurrent"]) || 1,
          model: (cfg["model"] as string) || null,
          integrationId: (payload["integrationId"] as string) || null,
          systemPromptId: (payload["systemPromptId"] as string) || null,
          instructionsPromptId: (payload["instructionsPromptId"] as string) || null,
          projectCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          modelConfig: { ...cfg, apiKey: cfg["apiKey"] ? "********" : undefined },
        };
        agents.push(created);
        return json(route, { agent: created }, 201);
      }
      return route.continue();
    });
    await page.route("**/api/admin/agents/*", async (route) => {
      const method = route.request().method();
      const m = /\/agents\/([^/]+)$/.exec(route.request().url());
      const id = m ? m[1] : "";
      if (method === "GET") {
        const found = agents.find((a) => a.id === id);
        return found ? json(route, { agent: found }) : json(route, { error: "not found" }, 404);
      }
      return route.continue();
    });

    // Projects endpoints
    await page.route("**/api/admin/projects", async (route) => {
      const method = route.request().method();
      if (method === "GET") return json(route, { projects });
      if (method === "POST") {
        const payload = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
        const ts = payload["ticketSource"] as { integrationId: string; ticketProjectKey: string } | undefined;
        const conflict = ts ? projects.find((p) => p.type === "coding" && p.ticketSource && p.ticketSource.integration?.id === ts.integrationId && p.ticketSource.ticketProjectKey === ts.ticketProjectKey) : undefined;
        if (conflict) {
          return json(route, {
            error: "Conflict",
            message: `Ticket source (${ts!.integrationId}, ${ts!.ticketProjectKey}) is already claimed by project '${conflict.name}' (${conflict.id})`,
            conflictingProjectId: conflict.id,
            conflictingProjectName: conflict.name,
          }, 409);
        }
        const id = "project-" + (projects.length + 1);
        const agentId = String(payload["agentId"] || "");
        const agent = agents.find((a) => a.id === agentId);
        const integ = ts ? STUB_INTEGRATIONS.find((i) => i.id === ts.integrationId) : null;
        const pts = ((payload["pushTargets"] as PushTarget[] | undefined) || []);
        const created: ProjectRow = {
          id,
          name: String(payload["name"] || ""),
          type: (payload["type"] as "coding" | "review") || "coding",
          agentId,
          agentName: agent ? agent.name : null,
          enabled: Boolean(payload["enabled"]),
          pushTargetCount: pts.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ticketSource: ts ? {
            integration: integ ? { id: integ.id, name: integ.name, type: integ.type } : null,
            ticketProjectKey: ts.ticketProjectKey,
          } : null,
          reviewConfig: null,
          pushTargets: pts,
          agentOverrideJson: null,
          postCloneScript: String(payload["postCloneScript"] || ""),
        };
        projects.push(created);
        if (agent) agent.projectCount += 1;
        return json(route, { project: created }, 201);
      }
      return route.continue();
    });
    await page.route("**/api/admin/projects/*", async (route) => {
      const method = route.request().method();
      const m = /\/projects\/([^/]+)$/.exec(route.request().url());
      const id = m ? m[1] : "";
      if (method === "GET") {
        const found = projects.find((p) => p.id === id);
        return found ? json(route, { project: found }) : json(route, { error: "not found" }, 404);
      }
      return route.continue();
    });

    // Plain stubs for the other dashboard fetches so boot completes.
    await page.route("**/api/admin/status", (route) => json(route, { polling: { running: false, intervalMs: 30000 }, runtime: { nodeEnv: "test", logLevel: "info", maxAgentCycles: 3, maxRetryAttempts: 5 } }));
    await page.route("**/api/admin/config", (route) => json(route, { config: {} }));
    await page.route("**/api/admin/providers", (route) => json(route, { providers: [] }));
    await page.route("**/api/admin/tasks", (route) => json(route, { tasks: [] }));
    await page.route("**/api/admin/plugins", (route) => json(route, { plugins: [] }));
    await page.route("**/api/admin/prompts", (route) => json(route, { prompts: [] }));

    await page.goto("/admin");
    await page.waitForSelector(".app", { timeout: 10000 });
  });

  test("creates an agent and a coding project using discovered resources", async ({ page }) => {
    // Navigate to Configuration → Agents Library
    await page.locator('[data-nav="configuration"]').click();
    await page.locator('[data-config-section="agents-library"]').click();
    await expect(page.locator('[data-role="configuration-content"]')).toContainText('No agents');

    // Open New Agent modal
    await page.locator('button[data-role="add-agent"]').click();
    await page.locator('input[data-f="name"]').fill('My Coding Bot');
    await page.locator('select[data-f="type"]').selectOption('coding');
    await page.locator('input[data-f="maxConcurrent"]').fill('1');
    await page.locator('.modal button[data-role="save"]').click();

    // Verify agent in table
    await expect(page.locator('table[data-role="agents-table"] tbody tr')).toHaveCount(1);
    await expect(page.locator('table[data-role="agents-table"]')).toContainText('My Coding Bot');

    // Navigate to Projects
    await page.locator('[data-config-section="projects"]').click();
    await expect(page.locator('[data-role="configuration-content"]')).toContainText('No projects');

    // Open New Project modal
    await page.locator('button[data-role="add-project"]').click();
    await page.locator('div[data-role="project-modal"] input[data-f="name"]').fill('App Project');
    await page.locator('div[data-role="project-modal"] select[data-f="type"]').selectOption('coding');

    // Ticket source — populated from STUB_INTEGRATIONS
    await page.locator('[data-tsf="integrationId"]').selectOption('redmine-stub');
    await page.locator('[data-tsf="ticketProjectKey"]').selectOption('PLATFORM');

    // Add 2 push targets
    await page.locator('button[data-role="add-pt"]').click();
    await page.locator('button[data-role="add-pt"]').click();
    const firstRow = page.locator('.pt-row').nth(0);
    await firstRow.locator('[data-pf="integrationId"]').selectOption('gerrit-stub');
    await firstRow.locator('[data-pf="repoKey"]').selectOption('platform/api');
    const secondRow = page.locator('.pt-row').nth(1);
    await secondRow.locator('[data-pf="integrationId"]').selectOption('gerrit-stub');
    await secondRow.locator('[data-pf="repoKey"]').selectOption('platform/lib');

    // Verify reorder works (push the second row up)
    await secondRow.locator('button[data-pa="up"]').click();
    // After reorder, the first row should now reference platform/lib
    const firstAfter = page.locator('.pt-row').nth(0);
    await expect(firstAfter.locator('[data-pf="repoKey"]')).toHaveValue('platform/lib');

    // Save
    await page.locator('div[data-role="project-modal"] button[data-role="save"]').click();

    // Verify project appears
    await expect(page.locator('table[data-role="projects-table"] tbody tr')).toHaveCount(1);
    await expect(page.locator('table[data-role="projects-table"]')).toContainText('App Project');
    await expect(page.locator('table[data-role="projects-table"]')).toContainText('PLATFORM');

    // Try creating a duplicate — expect inline 409 error
    await page.locator('button[data-role="add-project"]').click({ force: true });
    await page.locator('div[data-role="project-modal"] input[data-f="name"]').fill('Duplicate');
    await page.locator('[data-tsf="integrationId"]').selectOption('redmine-stub');
    await page.locator('[data-tsf="ticketProjectKey"]').selectOption('PLATFORM');
    await page.locator('button[data-role="add-pt"]').click();
    await page.locator('.pt-row').nth(0).locator('[data-pf="integrationId"]').selectOption('gerrit-stub');
    await page.locator('.pt-row').nth(0).locator('[data-pf="repoKey"]').selectOption('platform/api');
    await page.locator('div[data-role="project-modal"] button[data-role="save"]').click();
    await expect(page.locator('div[data-role="project-modal"] [data-role="modal-error"]')).toContainText('App Project');
  });
});
