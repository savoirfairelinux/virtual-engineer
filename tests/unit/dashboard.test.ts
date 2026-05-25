import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { renderAdminDashboardHtml, adminDashboardCss } from "../../src/admin/dashboard.js";

function extractSection(html: string, startToken: string, endToken: string): string {
  const start = html.indexOf(startToken);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf(endToken, start + startToken.length);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("renderAdminDashboardHtml", () => {
  it("renders a dashboard shell without auth prompt by default", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("Virtual Engineer");
    expect(html).toContain('window.__VE_ADMIN_BOOTSTRAP__ = {"requiresAuth":false,"authMode":"none","gerritBaseUrl":null,"gitlabBaseUrl":null,"ticketLinkTemplates":{}}');
  });

  it("renders bootstrap config for auth-protected mode", () => {
    const html = renderAdminDashboardHtml({ requiresAuth: true, authMode: "hmac" });

    expect(html).toContain('window.__VE_ADMIN_BOOTSTRAP__ = {"requiresAuth":true,"authMode":"hmac","gerritBaseUrl":null,"gitlabBaseUrl":null,"ticketLinkTemplates":{}}');
  });

  it("renders icon actions in the task detail header", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-action="pause"');
    expect(html).toContain('data-action="resume"');
    expect(html).toContain('data-action="retry"');
    expect(html).toContain('data-action="abandon"');
    expect(html).toContain("task-action-btn");
    expect(html).toContain('task-action-btn" data-action="pause" title="Pause task" aria-label="Pause task"><svg');
    expect(html).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain('data-action="retry" title="Retry task" aria-label="Retry task"><svg viewBox="-1 -1 26 26"');
    expect(html).toContain('<path d="M18.5 6.5v4.5h-4.5"/>');
    expect(html).toContain("detail-head-actions");
    expect(html).not.toContain("task-row-controls");
  });

  it("renders live logs panel in the JavaScript", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("logs-output");
    expect(html).toContain("Waiting for logs...");
    expect(html).toContain('data-role="close-logs"');
    expect(html).toContain("log-entry");
    expect(html).not.toContain('data-filter="session"');
    expect(html).not.toContain('>Session<');
  });

  it("includes CSS styles for icon task actions", () => {
    expect(adminDashboardCss).toContain(".task-action-btn");
    expect(adminDashboardCss).toContain(".task-action-btn:hover");
    expect(adminDashboardCss).toContain("width: 28px");
    expect(adminDashboardCss).toContain("backdrop-filter: blur(6px)");
    expect(adminDashboardCss).toContain("translateY(-0.5px)");
    expect(adminDashboardCss).toContain(".task-action-btn[data-action=abandon]");
    expect(adminDashboardCss).toContain(".task-action-btn svg");
    expect(adminDashboardCss).not.toContain('.task-action-btn[data-action=resume] svg');
    expect(adminDashboardCss).not.toContain('.task-action-btn[data-action=retry] svg');
    expect(adminDashboardCss).toContain("button:disabled");
  });

  it("includes CSS styles for live logs panel", () => {
    expect(adminDashboardCss).toContain(".logs-panel");
    expect(adminDashboardCss).toContain(".logs-output");
    expect(adminDashboardCss).toContain(".log-entry");
  });

  it("includes JavaScript for action button handlers", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("connectLogsStream");
    expect(html).toContain("disconnectLogsStream");
    expect(html).toContain("onActionClick");
    expect(html).toContain("addLogLine");
    expect(html).toContain("showActionToast");
  });

  it("renders explicit load-error handling for core boot sections", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("loadCoreSection('status'");
    expect(html).toContain("loadCoreSection('providers'");
    expect(html).toContain("loadCoreSection('tasks'");
    expect(html).toContain("renderSectionLoadError");
    expect(html).toContain("Failed to load tasks");
    expect(html).toContain("void selectTask(keepId).catch(");
    expect(html).toContain("showActionToast('Failed to load task details: '");
  });

  it("includes auth form text when auth is required", () => {
    const html = renderAdminDashboardHtml({ requiresAuth: true, authMode: "mixed" });

    expect(html).not.toContain("ADMIN_API_TOKEN");
    expect(html).toContain("Enter ADMIN_AUTH_SECRET");
    expect(html).toContain("ADMIN_AUTH_SECRET");
    expect(html).toContain("Unlock dashboard");
  });

  it("passes the selected task to the live logs stream", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("/api/admin/logs/stream?taskId=");
  });

  it("renders the sidebar and topbar structural elements", () => {
    const html = renderAdminDashboardHtml();

    // Sidebar data-role slots populated by JS
    expect(html).toContain('data-role="tasks"');
    expect(html).toContain('data-role="providers"');
    expect(html).toContain('data-role="configuration-shell"');
    // Topbar controls
    expect(html).toContain('data-role="status-bar"');
    expect(html).toContain('data-role="refresh"');
    expect(html).toContain('data-role="logout"');
    // Detail pane
    expect(html).toContain('data-role="task-detail"');
  });

  it("renders the configuration shell anchors", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-role="configuration-nav"');
    expect(html).toContain('data-role="configuration-content"');
    expect(html).toContain('data-role="configuration-main"');
    expect(html).toContain('data-expand-integration-id="');
  });

  it("does not render provider management sections in the tasks sidebar", () => {
    const html = renderAdminDashboardHtml();

    expect(html).not.toContain('<div data-role="providers-ticketing"></div>');
    expect(html).not.toContain('<div data-role="providers-review"></div>');
    expect(html).not.toContain('<div data-role="providers-agent"></div>');
    expect(html).not.toContain("Ticketing Providers");
    expect(html).not.toContain("Review Providers");
    expect(html).not.toContain("Agent Providers");
    expect(html).toContain('data-view="configuration"');
    expect(html).toContain('data-role="configuration-shell"');
  });

  it("renders integration editing affordances with secret preservation guidance", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('data-edit-id="');
    expect(html).toContain('data-role="drawer-edit-save"');
    expect(html).toContain('data-role="drawer-edit-test"');
    expect(html).toContain('placeholder="********"');
  });

  it("renders stream-events details from provider capability instead of Gerrit type", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("selected.streamEventsSupported === true");
    expect(html).toContain("No live stream state available for this integration.");
    expect(html).not.toContain("No live stream state available for this Gerrit integration.");
  });

  it("renders Prompts section in Configuration view instead of dedicated tab", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("Prompts");
    expect(html).toContain('data-nav="tasks"');
    expect(html).toContain('data-nav="configuration"');
    // Old prompts tab should NOT exist
    expect(html).not.toContain('data-nav="prompts"');
    expect(html).not.toContain('data-view="prompts"');
    expect(html).not.toContain('data-role="prompts-list"');
    expect(html).not.toContain('data-role="prompt-textarea"');
  });

  it("includes JavaScript for loading and rendering prompts configuration", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("loadPrompts()");
    expect(html).toContain("showPromptsModal");
    expect(html).toContain("createPrompt");
    expect(html).toContain("updatePrompt");
    expect(html).toContain("deletePrompt");
    expect(html).toContain("/api/admin/prompts");
    expect(html).toContain("Prompt created");
    expect(html).toContain("Prompt updated");
    expect(html).toContain("Prompt deleted");
    expect(html).toContain("textarea");
  });

  it("renders task titles and descriptions in the dashboard script", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("task.ticketTitle");
    expect(html).toContain("task.ticketDescription");
  });

  it("renders the Redmine provenance label in the dashboard script", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("formatTaskOrigin");
    expect(html).toContain("task.ticketSourceLabel");
    expect(html).toContain("toUpperCase()");
    expect(html).toContain("'ticket'");
    expect(html).toContain("task-title");
    expect(html).toContain("task-tags");
    expect(html).toContain('<span class="badge task-origin-badge">');
    expect(html).toContain("detail-origin");
    expect(html).toContain("detail-title-text");
    expect(html).toContain("detail-description");
    expect(html).toContain("task.taskId");
  });

  it("uses position: relative/absolute for detail-head layout", () => {
    // Detail head should use position: relative for absolute-positioned children
    expect(adminDashboardCss).toContain(".detail-head");
    expect(adminDashboardCss).toContain("position: relative;");
    expect(adminDashboardCss).toContain("padding: 20px;");
    expect(adminDashboardCss).toContain("background: var(--surface);");
    expect(adminDashboardCss).toContain("border: 1px solid var(--border);");
    expect(adminDashboardCss).toContain("border-radius: 8px;");
    expect(adminDashboardCss).toContain("margin-bottom: 20px;");
  });

  it("positions badge absolutely in top-right corner", () => {
    // Badge should break out of flex with absolute positioning
    expect(adminDashboardCss).toContain(".detail-head .badge");
    expect(adminDashboardCss).toContain("position: absolute;");
    expect(adminDashboardCss).toContain("top: 16px;");
    expect(adminDashboardCss).toContain("right: 16px;");
  });

  it("renders detail elements as direct children of detail-head (flattened structure)", () => {
    const html = renderAdminDashboardHtml();

    // No .detail-main wrapper should exist
    expect(html).not.toContain(".detail-main { flex: 1");
    expect(html).not.toContain("'<div class=\"detail-main\">");

    // Badge and content are siblings in detail-head, not wrapped
    expect(html).toContain("'<div class=\"detail-head\">' +");
    expect(html).toContain("'<span class=\"badge\" data-tone=\"' + tone(task.state) + '\">' + esc(task.state) + '</span>' +");
  });

  it("renders badge as first child of detail-head before content", () => {
    const html = renderAdminDashboardHtml();

    // Badge should appear first in detail-head, before the origin link
    const detailHeadStart = html.indexOf("'<div class=\"detail-head\">");
    expect(detailHeadStart).toBeGreaterThan(-1);
    const badgeIndex = html.indexOf("class=\"badge\"", detailHeadStart);
    const originIndex = html.indexOf("class=\"detail-origin\"", detailHeadStart);

    expect(badgeIndex).toBeGreaterThan(0);
    expect(originIndex).toBeGreaterThan(badgeIndex);
  });

  it("does not apply flex layout to detail-head", () => {
    const html = renderAdminDashboardHtml();

    // The old flex-between layout should be replaced with position-relative
    expect(html).not.toContain(".detail-head { display: flex; align-items: flex-start; justify-content: space-between;");
    expect(html).not.toContain(".detail-head { display: flex;");
  });

  it("detail description text aligns left without flex indentation", () => {
    // Detail description should have no special flexbox-related width constraints
    expect(adminDashboardCss).toContain(".detail-description");
    expect(adminDashboardCss).toContain("font-size: 13px; color: var(--text);");
    // Should NOT contain the flex workaround of wrapping in .detail-copy
    expect(adminDashboardCss).not.toContain(".detail-copy { display: flex;");
  });

  it("preserves markdown rendering in flattened detail structure", () => {
    const html = renderAdminDashboardHtml();

    // Markdown rendering should still work (no implementation change)
    expect(html).toContain("renderRichText(detailDescription, { baseUrl: imgBaseUrl, proxyPrefix: imgProxy })");
    expect(html).toContain("function renderRichText(v, options)");
    expect(html).toContain("function renderRichInline(v)");
    expect(html).toContain("parseHeading(line)");
    expect(html).toContain("parseUnorderedItem(line)");
  });

  it("preserves image rendering in detail description after layout refactor", () => {
    const html = renderAdminDashboardHtml();

    // Image rendering via parseImageLine and renderRichImage should still work
    expect(html).toContain("function parseImageLine(line)");
    expect(html).toContain("function renderRichImage(image, options)");
    expect(adminDashboardCss).toContain(".detail-description img { max-width: 100%; height: auto; display: block; }");
    expect(html).toContain("resolveRichAssetUrl(image.url, options?.baseUrl)");
  });

  it("origin, title, subtitle, and description flow vertically with no flex wrapper", () => {
    const html = renderAdminDashboardHtml();

    // CSS: validate element-level display rules
    expect(adminDashboardCss).toContain(".detail-origin { display: inline-block; font-size: 11px;");
    expect(adminDashboardCss).toContain(".detail-title-text { display: block; font-size: 18px; font-weight: 700;");
    expect(adminDashboardCss).toContain(".detail-subtitle { font-size: 12px; color: var(--muted); margin-top: 6px;");
    expect(adminDashboardCss).toContain(".detail-description { font-size: 13px; color: var(--text); margin-top: 14px; line-height: 1.6;");

    // Each element is independent block/inline element, no flex dependencies
    expect(html).toContain("'<span class=\"detail-origin\">'");
    expect(html).toContain("'<span class=\"detail-title-text\">'");
    expect(html).toContain("'<div class=\"detail-subtitle\">'");
    expect(html).toContain("renderRichText(detailDescription, { baseUrl: imgBaseUrl, proxyPrefix: imgProxy })");
  });

  it("badge does not participate in flex layout flow", () => {
    // Validate old flex layout is removed
    expect(adminDashboardCss).not.toContain(".detail-head { display: flex");
    // Validate new positioning
    expect(adminDashboardCss).toContain(".detail-head");
    expect(adminDashboardCss).toContain("position: relative;");
    expect(adminDashboardCss).toContain(".detail-head .badge");
    expect(adminDashboardCss).toContain("position: absolute;");
    expect(adminDashboardCss).toContain("top: 16px;");
    expect(adminDashboardCss).toContain("right: 16px;");
  });

  it("renders markdown images for ticket descriptions", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function parseImageLine(line)");
    expect(html).toContain("function resolveRichAssetUrl(url, baseUrl)");
    expect(html).toContain("blocks.push(renderRichImage(image, options))");
    expect(adminDashboardCss).toContain(".cycle-rich-text img,");
    expect(adminDashboardCss).toContain(".detail-description img { max-width: 100%; height: auto; display: block; }");
    expect(html).toContain("new URL(raw, baseUrl).toString()");
  });

  it("includes gitlabBaseUrl in the bootstrap config", () => {
    const html = renderAdminDashboardHtml({ gitlabBaseUrl: "https://git.example.com" });

    expect(html).toContain('"gitlabBaseUrl":"https://git.example.com"');
    expect(html).toContain("const imgBaseUrl = ticketLink(task) || BC.gitlabBaseUrl || null");
  });
  it("renders provenance and status tags on the first line above the title", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("task-meta");
    expect(adminDashboardCss).toContain("display: flex");
    expect(adminDashboardCss).toContain("flex-direction: row");
    expect(html).toContain("task-origin-badge");
    expect(html).toContain('class="badge badge-link" data-tone="');
    expect(html).not.toContain("task-description");
  });

  it("renders task actions before the badge in the task detail header", () => {
    const html = renderAdminDashboardHtml();
    const detailHeadStart = html.indexOf("'<div class=\"detail-head\">'");
    const metaGridStart = html.indexOf("'<div class=\"meta-grid\">'", detailHeadStart);
    const detailHeadSection = html.slice(detailHeadStart, metaGridStart);

    expect(html).toContain("detail-head-actions");
    expect(html).toContain("title=\"Pause task\"");
    expect(html).toContain("title=\"Resume task\"");
    expect(html).toContain("title=\"Retry task\"");
    expect(html).toContain("title=\"Abandon task\"");

    const actionsIndex = detailHeadSection.indexOf("detail-head-actions");
    const helperIndex = detailHeadSection.indexOf("renderTaskActionButtons()", actionsIndex);
    const badgeIndex = detailHeadSection.indexOf("class=\"badge\"", actionsIndex);

    expect(actionsIndex).toBeGreaterThan(-1);
    expect(helperIndex).toBeGreaterThan(actionsIndex);
    expect(badgeIndex).toBeGreaterThan(helperIndex);
  });

  it("renders the meta-grid with all 6 items on the same line", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("task-meta");
    expect(adminDashboardCss).toContain("grid-template-columns: repeat(6, auto);");
    expect(adminDashboardCss).toContain("gap: 10px;");
    expect(adminDashboardCss).toContain("align-items: center;");
  });

  it("uses an accent outline style for the provenance badge", () => {
    expect(adminDashboardCss).toContain(".task-origin-badge");
    expect(adminDashboardCss).toContain("color: var(--accent)");
    expect(adminDashboardCss).toContain("background: var(--accent-bg)");
  });

  it("keeps the source badge purple and linked task badges hoverable", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain('class="badge task-origin-badge badge-link"');
    expect(adminDashboardCss).toContain('.task-origin-badge.badge-link');
    expect(adminDashboardCss).toContain('color: var(--accent);');
    expect(adminDashboardCss).toContain(".task-tags .badge-link:hover");
    expect(adminDashboardCss).toContain("text-decoration: none;");
    expect(adminDashboardCss).toContain("cursor: pointer;");
  });

  it("uses the light theme design tokens", () => {
    expect(adminDashboardCss).toContain("--bg:");
    expect(adminDashboardCss).toContain("--surface:");
    expect(adminDashboardCss).toContain("--accent:");
    expect(adminDashboardCss).toContain("color-scheme: light");
  });

  it("includes a rich-text renderer for the agent response column", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function renderRichText(v, options)");
    expect(html).toContain("function renderRichInline(v)");
    expect(html).toContain("function replaceDelimited(text, marker, openTag, closeTag)");
    expect(html).toContain("function parseHeading(line)");
    expect(html).toContain("function parseUnorderedItem(line)");
    expect(html).toContain("function parseOrderedItem(line)");
    expect(html).toContain("<div class=\"cycle-rich-text cycle-panel\">' + renderRichText(c.result.summary || '\u2014') + '</div>'");
    expect(adminDashboardCss).toContain(".cycle-rich-text strong");
    expect(adminDashboardCss).toContain(".cycle-rich-text em");
    expect(adminDashboardCss).toContain(".cycle-rich-text u");
    expect(adminDashboardCss).toContain(".cycle-rich-text code");
    expect(adminDashboardCss).toContain(".cycle-rich-text ul");
    expect(adminDashboardCss).toContain(".cycle-rich-text ol");
    expect(adminDashboardCss).toContain(".cycle-rich-text h1");
    expect(adminDashboardCss).toContain(".cycle-rich-text h2");
    expect(adminDashboardCss).toContain(".cycle-rich-text h3");
    expect(html).toContain("listType = 'ul'");
    expect(html).toContain("listType = 'ol'");
  });

  it("uses full-width agent response column for all cycles", () => {
    const html = renderAdminDashboardHtml();

    expect(adminDashboardCss).toContain(".cycle-column { display: flex; flex-direction: column; min-width: 0; }");
    expect(adminDashboardCss).toContain(".cycle-panel { flex: 1; }");
    expect(html).toContain("<div class=\"cycle-rich-text cycle-panel\">' + renderRichText(c.result.summary || '—') + '</div>'");
    expect(html).toContain("<div class=\"cycle-col-label\">Agent Response</div>");
    expect(html).not.toContain("<div class=\"cycle-col-label\">Commit Message");
    expect(html).not.toContain("esc(c.result.commitMessage || '—')");
  });

  it("hides the files section when a cycle has no modified files", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("const modifiedFiles = c.result.modifiedFiles || [];");
    expect(html).toContain("(modifiedFiles.length");
    expect(html).toContain("? '<div style=\"margin-top:12px;font-size:12px;font-weight:bold;color:var(--text)\">Files</div>' +");
    expect(html).toContain(": ''");
  });

  it("uses a full-width agent response for failed cycles", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("'<div class=\"cycle-columns\">' +");
    expect(html).toContain("'<div class=\"cycle-column\">' +");
    expect(html).not.toContain("'<div class=\"cycle-col-label\">Commit Message");
  });

  it("omits the commit sha placeholder from the cycle title when absent", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("const commitShaSuffix = c.result.commitSha ? ' [' + esc(c.result.commitSha.slice(0, 8)) + ']' : '';");
    expect(html).toContain("'<span class=\"card-title\">Cycle ' + esc(String(c.cycleNumber)) + commitShaSuffix + cycleTs + '</span>'");
  });

  it("loadProviders calls renderStatusBar after receiving providers data", () => {
    const html = renderAdminDashboardHtml();

    // Find the loadProviders function definition in the embedded JS
    const fnStart = html.indexOf("async function loadProviders()");
    expect(fnStart).toBeGreaterThan(-1);

    // Isolate loadProviders' body: everything up to the next `async function load`
    // definition (loadConfig, loadTasks, loadPlugins, etc.). This prevents the test
    // from falsely passing because renderStatusBar() appears in a later sibling function.
    const nextFnStart = html.indexOf("async function load", fnStart + 1);
    expect(nextFnStart).toBeGreaterThan(fnStart);
    const fnBody = html.slice(fnStart, nextFnStart);

    // Bug: currently loadProviders only calls renderProviders(), so the topbar count stays
    // at whatever renderStatusBar() last wrote (often 0) until the page is refreshed.
    expect(fnBody).toContain("renderStatusBar()");
  });

  it("renderStatusBar excludes runtime-category providers from the topbar enabled count", () => {
    const html = renderAdminDashboardHtml();

    // The topbar should only count user-visible providers (ticketing / review / agent).
    // Bug: current filter is `pv.enabled` which also counts the 'admin-api' runtime entry,
    // making the topbar display a number that does not match the visible provider cards.
    // The correct filter must additionally exclude providers whose category is 'runtime'.
    expect(html).toContain("pv.category !== 'runtime'");
  });

  it("reloads providers after toggling an integration", () => {
    const html = renderAdminDashboardHtml();
    const fnBody = extractSection(html, "async function toggleIntegration(id)", "async function testIntegration(id)");

    expect(fnBody).toContain("await loadProviders();");
  });

  it("reloads providers after deleting an integration", () => {
    const html = renderAdminDashboardHtml();
    const fnBody = extractSection(html, "async function deleteIntegration(id)", "async function showAddIntegrationModal(section)");

    expect(fnBody).toContain("await loadProviders();");
  });

  it("reloads providers after creating and editing an integration", () => {
    const html = renderAdminDashboardHtml();
    const addModalBody = extractSection(html, "async function showAddIntegrationModal(section)", "// ── Actions ──");
    const editModalBody = extractSection(
      html,
      "root.querySelectorAll('[data-role=\"drawer-edit-save\"]').forEach((btn) => {",
      "root.querySelectorAll('[data-role=\"drawer-edit-test\"]').forEach((btn) => {"
    );

    expect(addModalBody).toContain("await loadProviders();");
    expect(editModalBody).toContain("await loadProviders();");
  });

  it("filters add-integration plugin choices by capabilities with category fallback", () => {
    const html = renderAdminDashboardHtml();
    const addModalBody = extractSection(html, "async function showAddIntegrationModal(section)", "// ── Actions ──");

    expect(html).toContain("function pluginSupportsCapability(plugin, capability)");
    expect(addModalBody).toContain("pluginSupportsCapability(p, categoryFilter)");
    expect(html).toContain("plugin.capabilities");
    expect(html).toContain("plugin.category === capability");
  });

  it("collects visible input and select config fields for add/edit integration flows", () => {
    const html = renderAdminDashboardHtml();
    const addModalBody = extractSection(html, "async function showAddIntegrationModal(section)", "// ── Actions ──");
    const editSaveBody = extractSection(
      html,
      "root.querySelectorAll('[data-role=\"drawer-edit-save\"]').forEach((btn) => {",
      "root.querySelectorAll('[data-role=\"drawer-edit-test\"]').forEach((btn) => {"
    );
    const editTestBody = extractSection(
      html,
      "root.querySelectorAll('[data-role=\"drawer-edit-test\"]').forEach((btn) => {",
      "bindSubmoduleListHandlers(root);"
    );

    expect(html).toContain("function isConfigFieldVisible(fieldEl)");
    expect(html).toContain("function collectConfigFields(root, options)");
    expect(html).toContain("root.querySelectorAll('[data-field], [data-select-field]')");
    expect(html).toContain("fieldEl.closest('[data-depends-on-field]')");
    expect(addModalBody).toContain("const config = collectConfigFields(overlay");
    expect(editSaveBody).toContain("const config = collectConfigFields(editRoot");
    expect(editTestBody).toContain("const config = collectConfigFields(editRoot");
  });

  it("allows oauth setup sections to be conditionally shown for auth fallbacks", () => {
    const html = renderAdminDashboardHtml();
    const oauthBody = extractSection(
      html,
      "function initDeviceOAuthButton(container, oauth, opts)",
      "async function showAddIntegrationModal(section)"
    );

    expect(oauthBody).toContain("oauth.dependsOn");
    expect(oauthBody).toContain("data-depends-on-field");
    expect(oauthBody).toContain("data-depends-on-value");
  });

  it("dispatches oauth setup rendering by mode and supports redirect flows", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function initOAuthButton(container, oauth, opts)");
    expect(html).toContain("if (oauth.mode === 'redirect') return initRedirectOAuthButton(container, oauth, opts);");
    expect(html).toContain("function generateOAuthState()");
    expect(html).toContain("function generatePKCECodeVerifier()");
    expect(html).toContain("async function buildPKCECodeChallenge(codeVerifier)");
    expect(html).toContain("function initRedirectOAuthButton(container, oauth, opts)");
    expect(html).toContain("const redirectUri = window.location.origin + window.location.pathname");
    expect(html).toContain("const oauthState = generateOAuthState();");
    expect(html).toContain("const codeVerifier = generatePKCECodeVerifier();");
    expect(html).toContain("const codeChallenge = await buildPKCECodeChallenge(codeVerifier);");
    expect(html).toContain("const resolvedConfig = await resolveGitLabOAuthConfig(container, config);");
    expect(html).toContain("const config = collectConfigFields(container, { trimValues: false });");
    expect(html).toContain("await adminFetch(oauth.startPath, 'POST', JSON.stringify({");
    expect(html).toContain("redirectUri,");
    expect(html).toContain("state: oauthState,");
    expect(html).toContain("codeChallenge,");
    expect(html).toContain("codeChallengeMethod: 'S256',");
    expect(html).toContain("config: resolvedConfig,");
    expect(html).toContain("window.open(startRes.authorizationUrl");
    expect(html).toContain("if (state !== oauthState)");
    expect(html).toContain("const latestConfig = collectConfigFields(container, { trimValues: false });");
    expect(html).toContain("const latestResolvedConfig = await resolveGitLabOAuthConfig(container, latestConfig);");
    expect(html).toContain("await adminFetch(oauth.completePath, 'POST', JSON.stringify({");
    expect(html).toContain("code,");
    expect(html).toContain("state,");
    expect(html).toContain("redirectUri,");
    expect(html).toContain("codeVerifier,");
    expect(html).toContain("config: latestResolvedConfig,");
    expect(html).toContain("async function resolveGitLabOAuthConfig(container, config)");
    expect(html).toContain("/api/admin/oauth-apps/resolve");
    expect(html).toContain("No OAuth app is configured for");
  });

  it("filters persisted integration selectors by capabilities with category fallback", () => {
    const html = renderAdminDashboardHtml();
    const projectModalBody = extractSection(html, "function showProjectModal(existing) {", "async function refreshIntegrationDiscovery(integrationId) {");
    const agentModalBody = extractSection(html, "function showAgentModal(existing) {", "function bindConcurrencyPanel()");

    expect(html).toContain("function integrationSupportsCapability(integration, capability)");
    expect(projectModalBody).toContain(".filter((i) => integrationSupportsCapability(i, 'ticketing'))");
    expect(projectModalBody).toContain(".filter((i) => integrationSupportsCapability(i, 'vcs'))");
    expect(projectModalBody).toContain(".filter((i) => integrationSupportsCapability(i, 'review'))");
    expect(agentModalBody).toContain("integrationSupportsCapability(i, 'agent')");
    expect(html).toContain("integration.capabilities");
    expect(html).toContain("integration.category === capability");
  });

  it("tests add and edit modal configs through the config test route without persisting changes", () => {
    const html = renderAdminDashboardHtml();
    const addTestBody = extractSection(
      html,
      "overlay.querySelector('[data-role=\"modal-test\"]')?.addEventListener('click', async () => {",
      "overlay.querySelector('[data-role=\"modal-save\"]')?.addEventListener('click', async () => {"
    );
    const editTestBody = extractSection(
      html,
      "root.querySelectorAll('[data-role=\"drawer-edit-test\"]').forEach((btn) => {",
      "bindSubmoduleListHandlers(root);"
    );

    expect(addTestBody).toContain("/api/admin/integrations/test");
    expect(addTestBody).not.toContain("__test__");
    expect(addTestBody).not.toContain("tempId");
    expect(editTestBody).toContain("/api/admin/integrations/test");
    expect(editTestBody).not.toContain("/api/admin/integrations/' + enc(selected.id), 'PUT'");
  });

  it("includes Agents Library model loading from the integration model cache", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function loadModelsForIntegration(integrationId, preselect)");
    expect(html).toContain("/api/admin/integrations/' + enc(integrationId) + '/models'");
    expect(html).toContain("/api/admin/integrations/' + enc(integrationId) + '/discover'");
    expect(html).toContain("Discovering models\u2026");
  });

  it("does not show Copilot model help text in integration add and edit modals", () => {
    const html = renderAdminDashboardHtml();

    expect(html).not.toContain("Run Test connection to load the available Copilot models into this field.");
  });

  it("ticketLink uses task.ticketUrl directly from task object", () => {
    const html = renderAdminDashboardHtml();

    // ticketLink should read from task.ticketUrl, not a template
    expect(html).toContain("function ticketLink(task)");
    expect(html).toContain("task.ticketUrl");
    // Should NOT use ticketLinkTemplates lookup anymore
    expect(html).not.toContain("BC.ticketLinkTemplates");
  });

  it("reviewLink uses task.reviewUrl directly from task object", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("function reviewLink(task)");
    expect(html).toContain("task.reviewUrl");
    // Should not reference the old gerritLink function name
    expect(html).not.toContain("function gerritLink(");
  });

  it("reviewLink remains available for detail and meta-card links", () => {
    const html = renderAdminDashboardHtml();

    expect(html).toContain("reviewLink(task)");
    expect(html).toContain("esc(reviewLink(task))");
    // Review meta-card now uses displayChangeId (falls back to CPR change ID)
    expect(html).toContain("metaCard('Review', displayChangeId");
  });

  it("detail panel review meta-card uses Review label (not Gerrit)", () => {
    const html = renderAdminDashboardHtml();

    // Detail panel should say 'Review' not 'Gerrit' for the link meta card
    expect(html).toContain('<div class="meta-label">Review</div>');
    // Review meta-card now uses displayChangeId (falls back to CPR change ID)
    expect(html).toContain("metaCard('Review', displayChangeId");
  });

  it("auto-discovers resources when selecting an integration in the project modal", () => {
    const html = renderAdminDashboardHtml();

    // ensureDiscovered helper is defined inside the project modal
    expect(html).toContain("async function ensureDiscovered(integrationId)");
    expect(html).toContain("integ.discoverySupported");
    expect(html).toContain("/discover', 'POST')");

    // All three integration change handlers call ensureDiscovered
    expect(html).toContain("await ensureDiscovered(integSel.value)");
    expect(html).toContain("await ensureDiscovered(newId)");
  });
});

describe("renderAdminDashboardHtml — connectGlobalStream", () => {
  it("includes connectGlobalStream function", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("connectGlobalStream");
  });

  it("connectGlobalStream connects to /api/admin/events/stream", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("/api/admin/events/stream");
  });

  it("connectGlobalStream handles tasks event to update task list", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("event: tasks");
    // or contains the handler for 'tasks' event
    expect(html).toContain("S.tasks");
  });

  it("connectGlobalStream has exponential backoff reconnect logic", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("backoff");
  });
});

describe("renderAdminDashboardHtml — embedded JavaScript validity", () => {
  function extractEmbeddedScript(html: string): string {
    // The two <script> blocks now carry a nonce attribute (empty string when no nonce is passed)
    const separator = '</script>\n    <script nonce="">';
    const idx = html.indexOf(separator);
    expect(idx).toBeGreaterThan(-1);
    const jsStart = idx + separator.length;
    const jsEnd = html.lastIndexOf("</script>");
    return html.slice(jsStart, jsEnd);
  }

  it("generates syntactically valid JavaScript with no literal newlines inside string literals", () => {
    const html = renderAdminDashboardHtml();
    const js = extractEmbeddedScript(html);

    // Use the Function constructor to validate JS syntax.
    // If \n inside template literal string is left as a real newline (0x0A) in the output,
    // it breaks JS string literals and causes a SyntaxError at runtime, making the UI blank.
    expect(() => new Function(js)).not.toThrow();
  });

  it("generated SSE stream parsing uses correct \\n escape sequences (not literal newlines)", () => {
    const html = renderAdminDashboardHtml();
    const js = extractEmbeddedScript(html);

    // These are the exact strings that must appear in the generated JS.
    // If they appear as actual newline characters instead, the UI breaks entirely.
    expect(js).toContain("buf.split('\\n\\n')");
    expect(js).toContain("part.split('\\n')");
    expect(js).toContain("buf.split('\\n')");
  });

  function makeRenderContext(gitlabBaseUrl: string | null = null, authToken: string | null = null) {
    const html = renderAdminDashboardHtml({ gitlabBaseUrl: gitlabBaseUrl ?? undefined });
    const js = extractEmbeddedScript(html);
    const bootstrap = { gitlabBaseUrl, ticketLinkTemplates: {}, gerritBaseUrl: null, requiresAuth: false, authMode: "none" };
    // Provide minimal browser globals the rendering functions need
    const ctx: Record<string, unknown> = {
      S: { authToken },
      localStorage: { getItem: () => authToken, setItem: () => {}, removeItem: () => {} },
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      window: { __VE_ADMIN_BOOTSTRAP__: bootstrap },
      console,
      URL,
      fetch: () => Promise.resolve(),
      encodeURIComponent,
      decodeURIComponent,
      // suppress top-level boot() and renderAuthPanel() calls
      setTimeout: () => {},
      clearTimeout: () => {},
    };
    runInNewContext(js, ctx);
    return ctx as typeof ctx & {
      parseImageLine: (line: string) => { alt: string; url: string } | null;
      renderRichText: (v: string, options?: { baseUrl?: string | null; proxyPrefix?: string | null }) => string;
      resolveRichAssetUrl: (url: string, baseUrl?: string | null) => string | null;
    };
  }

  it("parseImageLine matches a standalone GitLab image line", () => {
    const ctx = makeRenderContext();
    expect(ctx.parseImageLine("![image](/uploads/abc123/screenshot.png)")).toEqual({
      alt: "image", url: "/uploads/abc123/screenshot.png",
    });
    expect(ctx.parseImageLine("![my screenshot](/uploads/abc123/my_screenshot.png)")).toEqual({
      alt: "my screenshot", url: "/uploads/abc123/my_screenshot.png",
    });
    // Image NOT at start of line — should NOT match (inline images not supported)
    expect(ctx.parseImageLine("See this: ![image](/uploads/abc.png)")).toBeNull();
  });

  it("renderRichText renders a standalone image line into an <img> tag", () => {
    const ctx = makeRenderContext("https://gitlab.example.com");
    const desc = "Here is the bug:\n\n![image](/uploads/abc123/screenshot.png)\n\nMore text.";
    const result = ctx.renderRichText(desc, { baseUrl: "https://gitlab.example.com/group/proj/-/issues/1" });
    expect(result).toContain('<img src="https://gitlab.example.com/uploads/abc123/screenshot.png"');
    expect(result).toContain('alt="image"');
  });

  it("renderRichText uses proxy URL when proxyPrefix is provided", () => {
    const ctx = makeRenderContext("https://gitlab.example.com", "my-token");
    const proxyPrefix = "/api/admin/img-proxy?t=my-token&url=";
    const desc = "![image](/uploads/abc123/screenshot.png)";
    const result = ctx.renderRichText(desc, {
      baseUrl: "https://gitlab.example.com/group/proj/-/issues/1",
      proxyPrefix,
    });
    expect(result).toContain("/api/admin/img-proxy?t=my-token&amp;url=");
    expect(result).toContain("https%3A%2F%2Fgitlab.example.com%2Fuploads%2Fabc123%2Fscreenshot.png");
  });

  it("renderRichText falls back to text when image is inline (not on its own line)", () => {
    const ctx = makeRenderContext("https://gitlab.example.com");
    const desc = "See this screenshot: ![image](/uploads/abc123/screenshot.png) thanks";
    const result = ctx.renderRichText(desc, { baseUrl: "https://gitlab.example.com/group/proj/-/issues/1" });
    // Should NOT generate an img tag — image is inline with text
    expect(result).not.toContain("<img");
  });
});

describe("renderAdminDashboardHtml — cycle metrics regressions", () => {
  function extractEmbeddedScript(html: string): string {
    // The two <script> blocks now carry a nonce attribute (empty string when no nonce is passed)
    const separator = '</script>\n    <script nonce="">';
    const idx = html.indexOf(separator);
    expect(idx).toBeGreaterThan(-1);
    const jsStart = idx + separator.length;
    const jsEnd = html.lastIndexOf("</script>");
    return html.slice(jsStart, jsEnd);
  }

  function makeDashboardContext() {
    const html = renderAdminDashboardHtml();
    const js = extractEmbeddedScript(html);
    const bootstrap = {
      requiresAuth: false,
      authMode: "none",
      gerritBaseUrl: null,
      gitlabBaseUrl: null,
      ticketLinkTemplates: {},
    };
    const ctx: Record<string, unknown> = {
      window: { __VE_ADMIN_BOOTSTRAP__: bootstrap },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      console,
      URL,
      fetch: () => Promise.resolve(),
      encodeURIComponent,
      decodeURIComponent,
      setTimeout: () => {},
      clearTimeout: () => {},
    };

    runInNewContext(`${js}\nthis.__testExports = { S, renderCycles, renderLogDetail, updateMetricsFromEntry, shouldSuppressLiveLogEntry, formatEventType, getLogDisplayProps };`, ctx);
    return ctx as typeof ctx & {
      __testExports: {
        S: {
          cycles: Array<Record<string, unknown>>;
          sessionMetrics: {
            tokenUsage: {
              inputTokens: number;
              outputTokens: number;
              cacheReadTokens: number;
              cacheWriteTokens: number;
              totalTokens: number;
            };
            usageEventCount: number;
          };
        };
        renderCycles: () => string;
        renderLogDetail: (type: string, data: Record<string, unknown>) => string;
        updateMetricsFromEntry: (entry: Record<string, unknown>) => void;
        shouldSuppressLiveLogEntry: (entry: Record<string, unknown>) => boolean;
        formatEventType: (type: string) => string;
        getLogDisplayProps: (entry: Record<string, unknown>) => { eventType: string; message: string };
      };
    };
  }

  it("uses max token totals instead of double counting duplicate usage variants in cycle history", () => {
    const ctx = makeDashboardContext();
    ctx.__testExports.S.cycles = [{
      cycleNumber: 1,
      result: {
        status: "success",
        summary: "done",
        commitMessage: "fix(agent): keep token totals stable",
        modifiedFiles: [],
        agentEvents: [
          { type: "assistant.usage", data: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 } },
          { type: "session.usage_info", data: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 } },
        ],
      },
    }];

    const result = ctx.__testExports.renderCycles();
    expect(result).toContain("🪙 150 total");
    expect(result).toContain("📥 120 in");
    expect(result).toContain("📤 30 out");
    expect(result).toContain("⚡ 10 cache");
    expect(result).not.toContain("🪙 300 total");
    expect(result).not.toContain("📥 240 in");
    expect(result).not.toContain("📤 60 out");
  });

  it("shows cycle-level tool call stats without listing tool calls or assistant messages", () => {
    const ctx = makeDashboardContext();
    ctx.__testExports.S.cycles = [{
      cycleNumber: 2,
      result: {
        status: "success",
        summary: "done",
        commitMessage: "fix(agent): keep raw event rendering",
        modifiedFiles: [],
        agentEvents: [
          {
            type: "tool.execution_start",
            data: {
              toolCall: { function: { name: "replace_string_in_file" } },
              toolCallId: "call-1",
              arguments: { path: "/tmp/demo.ts" },
            },
          },
          {
            type: "assistant.message",
            data: {
              data: { content: "Applied targeted patch" },
            },
          },
        ],
      },
    }];

    const result = ctx.__testExports.renderCycles();
    expect(result).toContain("🔧 1 tool call");
    expect(result).not.toContain("replace_string_in_file");
    expect(result).not.toContain("Applied targeted patch");
    expect(result).not.toContain("Tool calls (1)");
    expect(result).not.toContain("Assistant messages");
  });

  it("shows cycle duration derived from session timestamps", () => {
    const ctx = makeDashboardContext();
    ctx.__testExports.S.cycles = [{
      cycleNumber: 3,
      result: {
        status: "success",
        summary: "done",
        commitMessage: "fix(agent): show cycle duration",
        modifiedFiles: [],
        agentEvents: [
          { type: "session.start", timestamp: "2026-04-23T19:47:46.000Z", data: {} },
          { type: "assistant.message", timestamp: "2026-04-23T19:47:52.000Z", data: { content: "Working" } },
          { type: "session.end", timestamp: "2026-04-23T19:48:11.000Z", data: {} },
        ],
      },
    }];

    const result = ctx.__testExports.renderCycles();
    expect(result).toContain("⏱ 25s");
  });

  it("keeps live metrics stable when both usage variants arrive for one turn", () => {
    const ctx = makeDashboardContext();

    ctx.__testExports.updateMetricsFromEntry({
      type: "assistant.usage",
      data: { inputTokens: 90, outputTokens: 40, cacheReadTokens: 12, cacheWriteTokens: 3, totalTokens: 130 },
    });
    ctx.__testExports.updateMetricsFromEntry({
      type: "session.usage_info",
      data: { inputTokens: 90, outputTokens: 40, cacheReadTokens: 12, cacheWriteTokens: 3, totalTokens: 130 },
    });

    expect(ctx.__testExports.S.sessionMetrics.tokenUsage).toEqual({
      inputTokens: 90,
      outputTokens: 40,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      totalTokens: 130,
    });
    expect(ctx.__testExports.S.sessionMetrics.usageEventCount).toBe(2);
  });

  it("renders nested assistant message details without falling back to raw JSON", () => {
    const ctx = makeDashboardContext();

    const result = ctx.__testExports.renderLogDetail("assistant.message", {
      data: { content: "Applied targeted patch" },
    });

    expect(result).toContain("log-detail-assistant");
    expect(result).toContain("Applied targeted patch");
    expect(result).not.toContain("log-detail-json");
  });

  it("renders assistant usage details from wrapped usage payloads", () => {
    const ctx = makeDashboardContext();

    const result = ctx.__testExports.renderLogDetail("assistant.usage", {
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });

    expect(result).toContain("Input tokens");
    expect(result).toContain(">12<");
    expect(result).toContain("Output tokens");
    expect(result).toContain(">3<");
    expect(result).not.toBe("");
  });

  it("renders session usage info details from wrapped payloads", () => {
    const ctx = makeDashboardContext();

    const result = ctx.__testExports.renderLogDetail("session.usage_info", {
      data: {
        tokenLimit: 200000,
        currentTokens: 12000,
        messagesLength: 18,
        systemTokens: 500,
        conversationTokens: 10500,
        toolDefinitionsTokens: 1000,
        isInitial: true,
      },
    });

    expect(result).toContain("Token limit");
    expect(result).toContain(">200000<");
    expect(result).toContain("Current tokens");
    expect(result).toContain(">12000<");
    expect(result).toContain("Messages");
    expect(result).toContain(">18<");
    expect(result).toContain("System tokens");
    expect(result).toContain("Conversation tokens");
    expect(result).toContain("Tool definitions");
    expect(result).not.toBe("");
  });

  it("does not render tool details in log rows", () => {
    const ctx = makeDashboardContext();

    const result = ctx.__testExports.renderLogDetail("tool.execution_complete", {
      data: { status: "success", durationMs: 42, output: "ok" },
      tool: { name: "bash" },
    });

    expect(result).toBe("");
  });

  it("formats usage event type labels with clear names", () => {
    const ctx = makeDashboardContext();

    expect(ctx.__testExports.formatEventType("tool.execution_start")).toBe("tool start");
    expect(ctx.__testExports.formatEventType("tool.execution_complete")).toBe("tool complete");
    expect(ctx.__testExports.formatEventType("tool.execution_progress")).toBe("tool progress");
    expect(ctx.__testExports.formatEventType("assistant.message")).toBe("assistant");
    expect(ctx.__testExports.formatEventType("assistant.usage")).toBe("model usage");
    expect(ctx.__testExports.formatEventType("session.start")).toBe("session start");
    expect(ctx.__testExports.formatEventType("session.end")).toBe("session end");
    expect(ctx.__testExports.formatEventType("session.usage_info")).toBe("context usage");
    expect(ctx.__testExports.formatEventType("permission.requested")).toBe("permission");
    expect(ctx.__testExports.formatEventType("stderr.line")).toBe("log");
  });

  it("suppresses redundant structured tool log rows while keeping the raw tool line", () => {
    const ctx = makeDashboardContext();

    expect(ctx.__testExports.shouldSuppressLiveLogEntry({
      type: "stderr.line",
      data: { line: "[tool] #18 bash(git status)" },
    })).toBe(false);

    expect(ctx.__testExports.shouldSuppressLiveLogEntry({
      type: "tool.execution_start",
      data: { name: "bash", input: { command: "git status" } },
    })).toBe(true);

    expect(ctx.__testExports.shouldSuppressLiveLogEntry({
      type: "permission.requested",
      data: { tool: "bash" },
    })).toBe(true);

    expect(ctx.__testExports.shouldSuppressLiveLogEntry({
      type: "tool.execution_complete",
      data: { name: "bash", status: "success" },
    })).toBe(true);

    expect(ctx.__testExports.shouldSuppressLiveLogEntry({
      type: "tool.execution_complete",
      data: { name: "bash", status: "error" },
    })).toBe(false);
  });

  it("renders raw stderr tool lines with a tool badge instead of a log badge", () => {
    const ctx = makeDashboardContext();

    const result = ctx.__testExports.getLogDisplayProps({
      type: "stderr.line",
      message: "[tool] #18 grep",
      data: { line: "[tool] #18 grep" },
    });

    expect(result).toEqual({ eventType: "tool.raw", message: "#18 grep" });
    expect(ctx.__testExports.formatEventType(result.eventType)).toBe("tool");
  });
});
