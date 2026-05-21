import { describe, expect, it } from "vitest";
import { renderAdminDashboardHtml, adminDashboardCss } from "../../src/admin/dashboard.js";

function extractSection(html: string, startToken: string, endToken: string): string {
  const start = html.indexOf(startToken);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf(endToken, start + startToken.length);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("Admin Dashboard - Configuration Shell", () => {
  it("renders the configuration top-level view and tab", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-nav="configuration"');
    expect(html).toContain('data-view="configuration"');
    expect(html).toContain("Configuration");
  });

  it("renders the three-part configuration shell", () => {
    const html = renderAdminDashboardHtml();
    const configurationView = extractSection(
      html,
      '<div class="page-view" data-view="configuration">',
      '</div>\n      </div>\n    </div>\n    <script nonce="">'
    );

    expect(configurationView).toContain('data-role="configuration-shell"');
    expect(configurationView).toContain('data-role="configuration-nav"');
    expect(configurationView).toContain('data-role="configuration-main"');
    expect(configurationView).toContain('data-role="configuration-header"');
    expect(configurationView).toContain('data-role="configuration-toolbar"');
    expect(configurationView).toContain('data-role="configuration-content"');
    expect(configurationView).not.toContain('data-role="configuration-drawer"');
  });

  it("defines configuration state with tickets as the default section", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("configurationSection: 'tickets'");
    expect(html).toContain("selectedConfigurationItemId: null");
    expect(html).toContain("configurationSearch: ''");
    expect(html).toContain("configurationDrawerOpen: false");
    expect(html).toContain("configurationFilters: { status: 'all' }");
  });

  it("caches configuration shell elements in the DOM lookup map", () => {
    const html = renderAdminDashboardHtml();
    const elObject = extractSection(html, "const el = {", "};\n\nq('[data-role=\"refresh\"]')");

    expect(elObject).toContain("configurationNav");
    expect(elObject).toContain("configurationHeader");
    expect(elObject).toContain("configurationToolbar");
    expect(elObject).toContain("configurationContent");
    expect(elObject).not.toContain("configurationDrawer");
  });

  it("includes configuration shell renderers and handlers", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function renderConfiguration()");
    expect(html).toContain("function renderConfigurationShell()");
    expect(html).toContain("function renderConfigurationNav()");
    expect(html).toContain("function renderConfigurationHeader()");
    expect(html).toContain("function renderConfigurationToolbar()");
    expect(html).toContain("function renderConfigurationSection()");
    expect(html).toContain("function setConfigurationSection(section)");
    expect(html).toContain("function selectConfigurationItem(id)");
    expect(html).toContain("function toggleConfigurationItem(id)");
  });

  it("renders secondary navigation entries for all planned configuration domains", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("Overview");
    expect(html).toContain("Tickets");
    expect(html).toContain("Code Review");
    expect(html).toContain("Agents");
    expect(html).toContain("System Settings");
    expect(html).toContain("Prompts");
    expect(html).toContain("data-config-section");
    // Integrations section is replaced by category sections
    expect(html).not.toContain("data-config-section=\"integrations\"");
  });

  it("renders tickets as the default active section", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("['tickets', 'code-review', 'agents'].includes(S.configurationSection)");
    expect(html).toContain("Configuration / ");
    expect(html).toContain("Manage ticket source integrations");
  });

  it("renders an integrations toolbar with search, filter, and add actions", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-role="configuration-search"');
    expect(html).toContain('data-role="configuration-filter"');
    expect(html).toContain('data-role="add-integration"');
    expect(html).toContain("Search integrations");
    expect(html).toContain("All statuses");
  });

  it("renders integrations in a selectable resource list with quick actions", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-role="config-integrations-table"');
    expect(html).toContain('data-select-integration-id="');
    expect(html).toContain("Updated");
    expect(html).toContain("data-toggle-id=");
    expect(html).toContain("data-edit-id=");
    expect(html).toContain("data-test-id=");
    expect(html).toContain("data-delete-id=");
  });

  it("wires integration row selection to expand the clicked item inline", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("S.selectedConfigurationItemId = id");
    expect(html).toContain("S.configurationDrawerOpen = !S.configurationDrawerOpen");
    expect(html).toContain("row.addEventListener('click'");
  });

  it("renders inline expansion controls instead of a drawer", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("integration-row-expand");
    expect(html).toContain("integration-row-details");
    expect(html).toContain("▲");
    expect(html).toContain("▼");
    expect(html).not.toContain("Reopen details");
  });

  it("renders integration details and existing actions inside the expanded row", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("Last updated");
    expect(html).toContain("Created");
    expect(html).toContain("Masked configuration");
    expect(html).toContain("toggleIntegration(selected.id)");
    expect(html).toContain("testIntegration(selected.id)");
    expect(html).toContain("deleteIntegration(selected.id)");
  });

  it("configurationDrawerMode defaults to view", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("configurationDrawerMode: 'view'");
  });

  it("openConfigurationDrawerEdit function exists", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("function openConfigurationDrawerEdit()");
  });

  it("closeConfigurationDrawerEdit function exists", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("function closeConfigurationDrawerEdit()");
  });

  it("Edit Integration button in the expanded row calls openConfigurationDrawerEdit not showEditIntegrationModal", () => {
    const html = renderAdminDashboardHtml();
    // The expanded-row edit button calls openConfigurationDrawerEdit (not showEditIntegrationModal directly)
    expect(html).toContain("openConfigurationDrawerEdit()");
    // showEditIntegrationModal still exists for row quick-action edit buttons
    expect(html).toContain("function showEditIntegrationModal(id)");
    // But the expanded-row action button no longer calls showEditIntegrationModal
    expect(html).not.toContain("showEditIntegrationModal(selected.id)");
  });

  it("renders a dedicated read-only system settings section from S.config", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function renderSystemSettingsView()");
    expect(html).toContain("System settings are currently read-only from the admin dashboard.");
    expect(html).toContain("Environment");
    expect(html).toContain("Max Retries");
    expect(html).toContain("S.config");
  });

  it("renders clear placeholders for future configuration sections", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function renderConfigurationOverview()");
    expect(html).toContain("function renderComingSoonSection(section)");
    expect(html).toContain("Prompts continue to use the dedicated top-level editor for now.");
  });

  it("renderConfigurationOverview uses live integration counts", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("S.integrations.length");
    expect(html).toContain("S.integrations.filter");
  });

  it("renderConfigurationOverview shows runtime configuration heading", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("Runtime Configuration");
  });

  it("overview rows link to category sections", () => {
    const html = renderAdminDashboardHtml();

    // Overview handler computes category section dynamically
    expect(html).toContain("data-overview-category=");
    expect(html).toContain("data-overview-section=\"tickets\"");
    expect(html).toContain("data-overview-section=\"code-review\"");
    expect(html).toContain("data-overview-section=\"agents\"");
    expect(html).toContain("selectConfigurationItem(");
    expect(html).toContain("Ticket Integrations");
    expect(html).toContain("Code Review Integrations");
    expect(html).toContain("Agent Integrations");
  });

  it("includes configuration shell CSS for layout, list, and drawer states", () => {
    expect(adminDashboardCss).toContain(".configuration-shell");
    expect(adminDashboardCss).toContain(".configuration-nav");
    expect(adminDashboardCss).toContain(".configuration-main");
    expect(adminDashboardCss).toContain(".configuration-toolbar");
    expect(adminDashboardCss).toContain(".resource-table");
    expect(adminDashboardCss).toContain(".integration-row");
    expect(adminDashboardCss).toContain(".integration-row.is-expanded");
  });

  it("renders expanded integration details flush with the row width and without an outer framed card", () => {
    expect(adminDashboardCss).toContain(".integration-row-details {\n  margin: 0;\n  padding: 0;");
    expect(adminDashboardCss).toContain("border: none;");
    expect(adminDashboardCss).toContain("background: transparent;");
  });

  it("keeps the tasks view intact while moving prompts into configuration section", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-view="tasks"');
    expect(html).toContain('data-view="configuration"');
    expect(html).toContain('data-role="task-detail"');
    // Prompts tab is now removed, prompts are in configuration
    expect(html).not.toContain('data-view="prompts"');
    expect(html).not.toContain('data-role="prompts-list"');
    expect(html).not.toContain('data-role="integrations"');
  });

  it("renderPromptsConfigSection renders prompts with Edit/Delete buttons via DOM API", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("function renderPromptsConfigSection()");
    expect(html).toContain("showPromptsModal");
    expect(html).toContain("deletePrompt");
    expect(html).toContain("[built-in]");
  });

  it("prompts section uses showPromptsModal for create/edit", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("function showPromptsModal(");
    expect(html).toContain("function closePromptsModal(");
    expect(html).toContain("async function createPrompt(");
    expect(html).toContain("async function updatePrompt(");
  });

  it("prompts section protects built-in prompts from deletion", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("isBuiltIn");
    expect(html).toContain("isDeletable");
    expect(html).toContain("BUILT_IN_PROMPT_IDS");
  });
});
