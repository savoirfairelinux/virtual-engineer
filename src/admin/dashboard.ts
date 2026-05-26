export const adminDashboardCss = `
:root {
  --bg:        #f1f5f9;
  --surface:   #ffffff;
  --border:    #e2e8f0;
  --border-strong: #cbd5e1;
  --text:      #1e293b;
  --muted:     #64748b;
  --accent:    #4f46e5;
  --accent-bg: #eef2ff;
  --ok:        #16a34a;
  --ok-bg:     #dcfce7;
  --warn:      #b45309;
  --warn-bg:   #fef9c3;
  --danger:    #dc2626;
  --danger-bg: #fee2e2;
  --font:      -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
  color-scheme: light;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }

body {
  font-family: var(--font);
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

/* ── Layout ── */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.page-content { flex: 1; overflow: hidden; display: flex; }
.page-view { display: none; width: 100%; height: 100%; overflow: hidden; }
.page-view.active { display: flex; }

.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  white-space: nowrap;
  letter-spacing: -0.01em;
}

.topbar-status {
  flex: 1;
  display: flex;
  gap: 24px;
  color: var(--muted);
  font-size: 13px;
}

.topbar-stat { display: flex; align-items: center; gap: 6px; }
.topbar-stat strong { color: var(--text); font-weight: 600; }

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── Nav bar ── */
.nav-bar {
  display: flex;
  align-items: flex-end;
  padding: 0 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  gap: 2px;
  flex-shrink: 0;
  height: 41px;
}
.nav-tab {
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--muted);
  font-weight: 500;
  cursor: pointer;
  font-size: 13px;
  margin-bottom: -1px;
  transition: color 120ms;
}
.nav-tab:hover { color: var(--text); background: transparent; box-shadow: none; border-bottom-color: var(--border-strong); }
.nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.workspace { display: flex; overflow: hidden; flex: 1; min-height: 0; }

.sidebar {
  width: 300px;
  min-width: 220px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--surface);
  flex-shrink: 0;
}

.detail { flex: 1; overflow-y: auto; padding: 12px 8px; background: var(--bg); }

/* ── Sections (sidebar) ── */
.section { border-bottom: 1px solid var(--border); }

.section-head {
  padding: 10px 16px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-transform: uppercase;
}
.section-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 16px;
}
.section-head-row .section-head {
  padding: 0;
}
.tasks-filter-icons {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tasks-filter-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  cursor: pointer;
  line-height: 1.4;
  white-space: nowrap;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.tasks-filter-btn:hover { background: var(--hover); color: var(--text); }
.tasks-filter-btn.is-active { background: var(--accent); color: #fff; border-color: var(--accent); }
.tasks-sort-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--muted);
  font-size: 13px;
  padding: 2px 5px;
  cursor: pointer;
  line-height: 1;
  transition: background 100ms, color 100ms;
}
.tasks-sort-btn:hover { background: var(--hover); color: var(--text); }
.tasks-filter-divider { width: 1px; height: 14px; background: var(--border); margin: 0 2px; }

details.section > summary { list-style: none; cursor: pointer; user-select: none; }
details.section > summary::-webkit-details-marker { display: none; }
details.section > summary::after { content: " ›"; font-size: 12px; float: right; transition: transform 150ms; }
details.section[open] > summary::after { content: " ›"; transform: rotate(90deg); }

/* ── Card ── */
.card {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.card:last-child { border-bottom: none; }
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.card-title { font-size: 13px; font-weight: 600; color: var(--text); }
.card-body { color: var(--muted); font-size: 12px; }
.card-body p { margin-top: 4px; }
.kv { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); }
.kv:last-child { border-bottom: none; }
.kv strong { color: var(--text); font-weight: 500; }
a.badge-link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  transition: box-shadow 120ms, transform 120ms, filter 120ms;
}
a.badge-link:hover,
a.badge-link:focus-visible {
  text-decoration: none;
}
.task-origin-badge.badge-link {
  color: var(--accent);
}
.task-tags .badge-link:hover,
.task-tags .badge-link:focus-visible {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent), 0 4px 12px rgba(79,70,229,0.14);
  transform: translateY(-1px);
  filter: saturate(1.05);
}
.cycle-summary {
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 4px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text);
}
.cycle-rich-text {
  white-space: normal;
  word-break: break-word;
  margin-top: 4px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
}
.cycle-rich-text br { content: ""; }
.cycle-rich-text strong { font-weight: 700; color: var(--text); }
.cycle-rich-text em { font-style: italic; }
.cycle-rich-text u { text-decoration: underline; text-underline-offset: 2px; }
.cycle-rich-text s { text-decoration: line-through; }
.cycle-rich-text h1,
.cycle-rich-text h2,
.cycle-rich-text h3 {
  color: var(--text);
  font-weight: 700;
  line-height: 1.3;
  margin: 8px 0 0;
}
.cycle-rich-text h1 { font-size: 16px; }
.cycle-rich-text h2 { font-size: 14px; }
.cycle-rich-text h3 { font-size: 13px; }
.cycle-rich-text ul,
.cycle-rich-text ol { margin: 6px 0 0 20px; padding: 0; }
.cycle-rich-text li + li { margin-top: 2px; }
.cycle-rich-text code {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--accent);
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
}
.cycle-rich-text img,
.detail-description img { max-width: 100%; height: auto; display: block; }
.cycle-rich-text .rich-image,
.detail-description .rich-image { margin-top: 10px; }
.file-list { list-style: none; display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.file-list li {
  color: var(--text);
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  padding: 2px 6px;
  background: var(--bg);
  border-radius: 3px;
}
.cycle-columns { display: block; margin-top: 8px; }
.cycle-column { display: flex; flex-direction: column; min-width: 0; }
.cycle-panel { flex: 1; }
.review-comments { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.review-comment { background: var(--bg); border-radius: 6px; padding: 8px 10px; border-left: 3px solid var(--accent); }
.review-comment-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.review-comment-file { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: var(--accent); }
.review-comment-body { font-size: 12px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.cycle-col-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }

/* ── Dot indicator ── */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.dot-ok      { background: var(--ok); box-shadow: 0 0 0 2px var(--ok-bg); }
.dot-neutral { background: var(--muted); box-shadow: 0 0 0 2px var(--border); }
.dot-warn    { background: var(--warn); box-shadow: 0 0 0 2px var(--warn-bg); }
.dot-bad     { background: var(--danger); box-shadow: 0 0 0 2px var(--danger-bg); }

/* ── Badge ── */
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 20px;
  white-space: nowrap;
}
.badge[data-tone=ok]      { color: var(--ok);     background: var(--ok-bg); }
.badge[data-tone=warn]    { color: var(--warn);   background: var(--warn-bg); }
.badge[data-tone=bad]     { color: var(--danger); background: var(--danger-bg); }
.badge[data-tone=neutral] { color: var(--muted);  background: var(--bg); border: 1px solid var(--border); }

/* ── Task rows ── */
.task-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 120ms;
}
.task-row:hover { background: var(--accent-bg); }
.task-row.is-selected {
  background: var(--accent-bg);
  border-left: 3px solid var(--accent);
  padding-left: 13px;
}
.task-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.task-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--text); }
.task-tags { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.task-origin-badge {
  color: var(--accent);
  background: var(--accent-bg);
}
.task-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.task-action-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--border) 78%, white 12%);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(248, 250, 252, 0.86) 100%),
    color-mix(in srgb, var(--surface) 92%, white);
  color: color-mix(in srgb, var(--muted) 78%, var(--text));
  line-height: 1;
  backdrop-filter: blur(6px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 4px 10px rgba(15, 23, 42, 0.05);
  transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.task-action-btn:hover {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(243, 247, 252, 0.9) 100%),
    color-mix(in srgb, var(--accent-bg) 20%, white);
  border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
  color: var(--accent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.68),
    0 2px 6px rgba(15, 23, 42, 0.05),
    0 8px 16px rgba(15, 23, 42, 0.05);
  transform: translateY(-0.5px);
}
.task-action-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  flex-shrink: 0;
  stroke-width: 1.7;
}
.task-action-btn:active {
  transform: translateY(0);
}
.task-action-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 2px;
}
.task-action-btn[data-action=abandon] {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 16%, var(--border));
}
.task-action-btn[data-action=abandon]:hover {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(254, 244, 244, 0.92) 100%),
    color-mix(in srgb, var(--danger-bg) 54%, white);
  border-color: color-mix(in srgb, var(--danger) 22%, var(--border));
  color: var(--danger);
}
.task-action-btn[data-action=delete] {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 16%, var(--border));
}
.task-action-btn[data-action=delete]:hover {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(254, 244, 244, 0.92) 100%),
    color-mix(in srgb, var(--danger-bg) 54%, white);
  border-color: color-mix(in srgb, var(--danger) 22%, var(--border));
  color: var(--danger);
}

/* ── Auth ── */
.auth-form { display: grid; gap: 10px; padding: 16px; }
.auth-form input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.auth-form input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}
.auth-error { font-size: 12px; color: var(--danger); padding: 0 16px 10px; }

/* ── Buttons ── */
button {
  padding: 6px 14px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, box-shadow 120ms;
  letter-spacing: -0.01em;
}
button:hover { background: var(--bg); border-color: var(--muted); box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
button.primary:hover { background: #4338ca; border-color: #4338ca; box-shadow: 0 2px 4px rgba(79,70,229,0.3); }
button.danger { border-color: var(--danger); color: var(--danger); background: transparent; }
button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
button:disabled { opacity: 0.45; cursor: not-allowed; pointer-events: none; }

/* ── Tabs ── */
.tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 20px; gap: 4px; }
.tab {
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--muted);
  font-weight: 500;
  cursor: pointer;
  transition: color 120ms;
  margin-bottom: -1px;
}
.tab:hover { color: var(--text); background: transparent; box-shadow: none; border-color: transparent; border-bottom-color: var(--border-strong); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ── Detail view ── */
.empty-state {
  color: var(--muted);
  padding: 64px 0;
  text-align: center;
  font-size: 14px;
}
.empty-state::before { content: "↖"; display: block; font-size: 28px; margin-bottom: 8px; opacity: 0.3; }
.detail-head {
  position: relative;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 20px;
}
.detail-head-actions {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-head .badge {
  position: static;
}
.detail-origin { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 6px; }
a.detail-origin { text-decoration: none; }
a.detail-origin:hover { text-decoration: underline; }
.detail-title-text { display: block; font-size: 18px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3; word-break: break-word; }
.detail-subtitle { font-size: 12px; color: var(--muted); margin-top: 6px; font-family: ui-monospace, monospace; }
.detail-description { font-size: 13px; color: var(--text); margin-top: 14px; line-height: 1.6; }
.detail-description > *:first-child { margin-top: 0; }
.detail-description div { margin-top: 6px; }
.detail-description strong { font-weight: 700; }
.detail-description em { font-style: italic; }
.detail-description u { text-decoration: underline; text-underline-offset: 2px; }
.detail-description s { text-decoration: line-through; }
.detail-description h1,
.detail-description h2,
.detail-description h3 { color: var(--text); font-weight: 700; line-height: 1.3; margin: 12px 0 4px; }
.detail-description h1 { font-size: 16px; }
.detail-description h2 { font-size: 14px; }
.detail-description h3 { font-size: 13px; font-weight: 600; }
.detail-description ul,
.detail-description ol { margin: 4px 0 6px 20px; padding: 0; }
.detail-description li + li { margin-top: 3px; }
.detail-description code {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--accent);
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(6, auto);
  gap: 10px;
  margin-bottom: 20px;
}
.meta-card {
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.meta-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 6px;
}
.meta-value { font-size: 13px; font-weight: 500; word-break: break-word; color: var(--text); }

.tab-content { display: none; }
.tab-content.active { display: block; }

/* ── Cycle & transition cards ── */
.tab-content .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.tab-content .card:last-child { border-bottom: 1px solid var(--border); }

/* ── Logs panel ── */
.logs-panel { margin-top: 24px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
.logs-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.logs-panel-head span {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.logs-filters {
  display: flex;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-wrap: wrap;
}
.logs-filter-btn {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s;
}
.logs-filter-btn:hover { border-color: var(--accent); color: var(--accent); }
.logs-filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

/* ── Metrics summary ── */
.metrics-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.metric-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.metric-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  font-family: ui-monospace, "SF Mono", monospace;
}
.metric-value.active { color: var(--accent); }
.metric-value.unavailable { color: var(--muted); font-style: italic; font-weight: 400; font-size: 11px; }

.logs-output { max-height: 340px; overflow-y: auto; }
.log-entry {
  padding: 4px 14px;
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  word-break: break-all;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.log-entry:last-child { border-bottom: none; }
.log-entry[data-level=error] { color: var(--danger); background: var(--danger-bg); }
.log-entry[data-level=warn]  { color: var(--warn); background: var(--warn-bg); }
.log-entry[data-level=info]  { color: var(--text); }
.log-entry[data-level=debug] { color: var(--muted); font-size: 11px; }
.log-entry[data-category=tools] { border-left: 3px solid var(--accent); }
.log-entry[data-category=usage] { border-left: 3px solid var(--ok); }
.log-entry[data-category=errors] { border-left: 3px solid var(--danger); }
.log-entry[data-category=session] { border-left: 3px solid var(--warn); }
.log-ts { color: var(--muted); flex-shrink: 0; font-size: 11px; }
.log-type-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  background: var(--border);
  color: var(--muted);
}
.log-type-badge[data-cat=tools] { background: var(--accent-bg); color: var(--accent); }
.log-type-badge[data-cat=usage] { background: var(--ok-bg); color: var(--ok); }
.log-type-badge[data-cat=errors] { background: var(--danger-bg); color: var(--danger); }
.log-type-badge[data-cat=session] { background: var(--warn-bg); color: var(--warn); }
.log-msg { flex: 1; min-width: 0; }
.log-entry.expandable { flex-wrap: wrap; cursor: pointer; }
.log-entry.expandable:hover { background: var(--surface); }
.log-entry-main { display: contents; }
.log-expand-hint { flex-shrink: 0; color: var(--muted); font-size: 11px; user-select: none; padding-left: 2px; }
.log-detail {
  flex-basis: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--bg);
  border-left: 2px solid var(--border);
  border-radius: 3px;
  font-size: 11px;
  display: none;
}
.log-detail.open { display: block; }
.log-detail-table { border-collapse: collapse; width: 100%; }
.log-detail-table td { padding: 2px 6px; vertical-align: top; }
.log-detail-key { color: var(--muted); white-space: nowrap; font-weight: 600; min-width: 100px; max-width: 140px; }
.log-detail-val pre { margin: 0; white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow-y: auto; }
.log-detail-output,
.log-detail-assistant,
.log-detail-json { margin: 0; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }

/* ── Cycle events ── */
.cycle-metrics-inline { display: flex; gap: 14px; margin-top: 10px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
.cycle-metrics-inline span { display: inline-flex; align-items: center; gap: 3px; }

/* ── Toast ── */
.action-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  animation: slideUp 200ms ease;
}
.action-toast.error { border-color: var(--danger); color: var(--danger); background: var(--danger-bg); }
.action-toast.ok    { border-color: var(--ok);     color: var(--ok);     background: var(--ok-bg); }

@keyframes slideUp {
  from { transform: translateY(8px); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}

@media (max-width: 720px) {
  .workspace { flex-direction: column; }
  .sidebar { width: 100%; min-width: 0; max-height: 40vh; }
  .meta-grid { grid-template-columns: repeat(2, 1fr); }
  .topbar-status { display: none; }
  .detail { padding: 12px 8px; }
}

/* ── Integration items ── */
.integration-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.integration-item:last-child { border-bottom: none; }
.integration-info { flex: 1; min-width: 0; }
.integration-name { font-size: 13px; font-weight: 600; color: var(--text); }
.integration-type { font-size: 11px; color: var(--muted); margin-top: 2px; }
.integration-actions { display: flex; gap: 6px; align-items: center; }

/* ── Toggle switch ── */
.toggle {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--border-strong);
  cursor: pointer;
  transition: background 200ms;
  border: none;
  padding: 0;
  overflow: hidden;
}
.toggle.on { background: var(--ok); }
.toggle::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: transform 200ms;
}
.toggle.on::after { transform: translateX(16px); }

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  min-width: 380px;
  max-width: 560px;
  width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.modal h3 {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 16px;
  letter-spacing: -0.02em;
}
.modal label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 4px;
  margin-top: 12px;
}
.modal input:not([type="checkbox"]), .modal select {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.modal textarea.post-clone-input {
  min-height: unset;
  font-family: monospace;
}
.modal textarea {
  width: 100%;
  min-height: 280px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.modal input:not([type="checkbox"]):focus, .modal select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}
.modal textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

/* ── Escape Confirmation Dialog ── */
.escape-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
}
.escape-confirm-dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  width: 90%;
  max-width: 380px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}
.escape-confirm-dialog h4 {
  margin-bottom: 8px;
  font-size: 14px;
}
.escape-confirm-dialog p {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 16px;
  line-height: 1.5;
}
.escape-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* ── Configuration Page ── */
.configuration-shell {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 16px;
  width: 100%;
  height: 100%;
  padding: 16px;
  overflow: hidden;
}
.configuration-nav,
.configuration-main {
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.configuration-nav {
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 6px;
  overflow-y: auto;
}
.configuration-nav-head {
  padding: 8px 10px 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.configuration-nav-kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.configuration-nav-title {
  margin-top: 4px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
}
.configuration-nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  gap: 2px;
}
.configuration-nav-item:hover {
  border-color: var(--border);
  background: var(--bg);
}
.configuration-nav-item.active {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, #fff), var(--surface));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 14%, transparent);
}
.configuration-nav-label { font-size: 13px; font-weight: 600; color: var(--text); }
.configuration-nav-meta { font-size: 11px; color: var(--muted); }
.configuration-nav-item.coming-soon .configuration-nav-meta { color: var(--warn); }
.configuration-main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.configuration-header {
  padding: 20px 22px 14px;
  border-bottom: 1px solid var(--border);
}
.configuration-breadcrumb {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.configuration-title-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-end;
  margin-top: 6px;
}
.configuration-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
}
.configuration-description {
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
  max-width: 72ch;
}
.configuration-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 22px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 60%, #fff);
}
.configuration-toolbar-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.configuration-toolbar-search,
.configuration-toolbar select {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  outline: none;
}
.configuration-toolbar-search {
  width: min(280px, 45vw);
}
.configuration-toolbar-search:focus,
.configuration-toolbar select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}
.configuration-toolbar-meta {
  color: var(--muted);
  font-size: 12px;
}
.configuration-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 22px 22px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg) 45%, #fff), var(--bg));
}
.configuration-panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  overflow: hidden;
}
.configuration-panel-body { padding: 18px 20px; }
.configuration-panel-note {
  margin-top: 10px;
  color: var(--muted);
  font-size: 13px;
}
.configuration-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.configuration-summary-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px;
}
.configuration-summary-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.configuration-summary-value {
  margin-top: 8px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
}
.config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
.config-item { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.config-item:last-child { border-bottom: none; }
.config-label { font-weight: 600; color: var(--text); font-size: 13px; }
.config-value { color: var(--muted); font-size: 13px; font-family: ui-monospace, monospace; text-align: right; word-break: break-word; }
.resource-table {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.resource-table-head,
.integration-row,
.agent-row,
.project-row {
  display: grid;
  gap: 12px;
  align-items: center;
}
.resource-table-head,
.integration-row {
  grid-template-columns: minmax(180px, 2fr) 110px 110px 110px 160px 190px 96px;
}
.resource-table-head.agent-table-head,
.agent-row {
  grid-template-columns: minmax(180px, 2fr) 110px 140px 190px 96px;
}
.resource-table-head.project-table-head,
.project-row {
  grid-template-columns: minmax(180px, 2fr) 110px minmax(160px, 2fr) 190px 96px;
}
.resource-table-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 60%, #fff);
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.integration-row,
.agent-row,
.project-row {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
.integration-row:last-child, .agent-row:last-child, .project-row:last-child { border-bottom: none; }
.integration-row:hover, .agent-row:hover, .project-row:hover { background: color-mix(in srgb, var(--accent) 6%, #fff); }
.integration-row.is-selected, .agent-row.is-selected, .project-row.is-selected {
  background: color-mix(in srgb, var(--accent) 10%, #fff);
  box-shadow: inset 3px 0 0 var(--accent);
}
.integration-row.is-expanded, .agent-row.is-expanded, .project-row.is-expanded {
  border-bottom-color: transparent;
}
.integration-row-wrap:last-child .integration-row.is-expanded,
.integration-row-wrap:last-child .agent-row.is-expanded,
.integration-row-wrap:last-child .project-row.is-expanded {
  border-bottom: none;
}
.integration-primary { min-width: 0; }
.integration-name { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.integration-subtitle { font-size: 11px; color: var(--muted); margin-top: 3px; }
.integration-cell { font-size: 12px; color: var(--text); }
.integration-cell.muted { color: var(--muted); }
.integration-quick-actions { display: flex; gap: 4px; justify-content: flex-start; align-items: center; }
.integration-quick-actions .toggle { flex-shrink: 0; }
.integration-row-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 44px;
  min-width: 44px;
  padding: 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 55%, #fff);
  color: var(--text);
  font-size: 16px;
  font-weight: 600;
}
.integration-row-expand:hover {
  border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, #fff);
}
.integration-row-chevron {
  display: inline-block;
  line-height: 1;
  color: var(--muted);
}
.icon-btn { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; background: transparent; border: none; outline: none; color: var(--muted); cursor: pointer; transition: background 120ms, color 120ms; }
.icon-btn:hover { background: var(--hover); color: var(--text); }
.icon-btn svg { display: block; flex-shrink: 0; }
.icon-btn.danger { color: var(--muted); }
.icon-btn.danger:hover { background: var(--danger-bg); color: var(--danger); }
.integration-row-details {
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
}
.integration-row-details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  border-top: 1px solid var(--border);
}
.integration-row-details-panel {
  border: none;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 12px 16px;
}
.integration-row-details-panel:nth-child(even) {
  border-right: none;
}
.integration-row-details-panel.integration-row-details-wide {
  grid-column: 1 / -1;
  border-right: none;
}
.integration-row-details-panel.integration-row-details-wide:last-child {
  border-bottom: none;
}
.integration-row-details-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.integration-row-details-title strong {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.integration-row-details-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 0;
}
.integration-row-edit-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.integration-row-edit-form label {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 2px;
}
.integration-row-edit-form input,
.integration-row-edit-form select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.integration-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--muted);
}
.overview-integration-table { display: flex; flex-direction: column; gap: 4px; }
.overview-integration-row {
  display: grid;
  grid-template-columns: 1fr 100px 80px;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: background 120ms;
}
.overview-integration-row:hover { background: color-mix(in srgb, var(--accent) 6%, #fff); }
.overview-integration-name { font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.overview-integration-type { color: var(--muted); }
.agent-empty,
.project-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--muted);
}
.configuration-drawer-panel {
  border: none;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 12px 16px;
}
.configuration-drawer-panel + .configuration-drawer-panel { margin-top: 0; }
.configuration-drawer-panel-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
}

@media (max-width: 1100px) {
  .configuration-shell {
    grid-template-columns: 200px minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .configuration-shell {
    grid-template-columns: 1fr;
    padding: 12px;
  }
  .configuration-nav {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 10px;
  }
  .configuration-nav-head {
    display: none;
  }
  .configuration-nav-item {
    min-width: 160px;
  }
  .configuration-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .configuration-toolbar-group {
    width: 100%;
  }
  .configuration-toolbar-search,
  .configuration-toolbar select {
    width: 100%;
  }
  .config-grid,
  .configuration-summary-grid {
    grid-template-columns: 1fr;
  }
  .resource-table-head {
    display: none;
  }
  .integration-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .integration-quick-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .integration-row-details {
    margin: 0 0 12px;
    padding: 14px;
  }
  .integration-row-details-grid {
    grid-template-columns: 1fr;
  }
}
`;

const script = `
const SECRET_MASK = '********';
const BC = window.__VE_ADMIN_BOOTSTRAP__;
const S = {
  authToken: storedToken(),
  status:    null,
  config:    null,
  providers: [],
  tasks:     [],
  selectedTaskId:  null,
  selectedTask:    null,
  cycles:          [],
  transitions:     [],
  activeTab:       'cycles',
  activeView:      'tasks',
  plugins:         [],
  integrations:    [],
  agents:          [],
  projects:        [],
  oAuthApps: [],
  configurationSection: 'tickets',
  selectedConfigurationItemId: null,
  configurationSearch: '',
  configurationDrawerOpen: false,
  configurationDrawerMode: 'view',
  configurationFilters: { status: 'all' },
  selectedAgentId: null,
  agentDrawerOpen: false,
  agentDrawerMode: 'view',
  selectedProjectId: null,
  projectDrawerOpen: false,
  projectDrawerMode: 'view',
  prompts:         [],
  selectedPromptId: null,
  logsFilter: 'all',
  tasksFilter: { state: 'all', sortDir: 'desc' },
  sessionMetrics: {
    tools: {},
    totalToolCalls: 0,
    activeToolName: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    usageEventCount: 0,
    sessionStartTime: null,
    sessionEndTime: null,
    quotaAvailable: false,
    quotaMessage: 'Not exposed by current SDK/CLI',
  },
};

const el = {
  statusBar:  q('[data-role="status-bar"]'),
  tasks:      q('[data-role="tasks"]'),
  providers:  q('[data-role="providers"]'),
  providersTicketing: q('[data-role="providers-ticketing"]'),
  providersReview: q('[data-role="providers-review"]'),
  providersAgent: q('[data-role="providers-agent"]'),
  detail:     q('[data-role="task-detail"]'),
  auth:       q('[data-role="auth"]'),
  authError:  q('[data-role="auth-error"]'),
  authStatus: q('[data-role="auth-status"]'),
  configurationNav: q('[data-role="configuration-nav"]'),
  configurationHeader: q('[data-role="configuration-header"]'),
  configurationToolbar: q('[data-role="configuration-toolbar"]'),
  configurationContent: q('[data-role="configuration-content"]'),
};

q('[data-role="refresh"]')?.addEventListener('click', () => void boot());
q('[data-role="logout"]')?.addEventListener('click', () => {
  clearToken();
  clearSecret();
  S.authToken = null;
  Object.assign(S, {
    status: null,
    config: null,
    providers: [],
    tasks: [],
    selectedTaskId: null,
    selectedTask: null,
    cycles: [],
    transitions: [],
    plugins: [],
    integrations: [],
    agents: [],
    projects: [],
    oAuthApps: [],
    configurationSection: 'tickets',
    selectedConfigurationItemId: null,
    configurationSearch: '',
    configurationDrawerOpen: false,
    configurationDrawerMode: 'view',
    configurationFilters: { status: 'all' },
    selectedAgentId: null,
    agentDrawerOpen: false,
    agentDrawerMode: 'view',
    selectedProjectId: null,
    projectDrawerOpen: false,
    projectDrawerMode: 'view',
    prompts: [],
    selectedPromptId: null,
  });
  renderAll();
  renderAuthPanel();
  showActionToast('Logged out.', false);
});

q('[data-nav="tasks"]')?.addEventListener('click', () => switchView('tasks'));
q('[data-nav="configuration"]')?.addEventListener('click', () => switchView('configuration'));
document.getElementById('filt-all')?.addEventListener('click', () => { S.tasksFilter.state = 'all'; renderTasks(); });
document.getElementById('filt-run')?.addEventListener('click', () => { S.tasksFilter.state = 'AGENT_RUNNING'; renderTasks(); });
document.getElementById('filt-rev')?.addEventListener('click', () => { S.tasksFilter.state = 'IN_REVIEW'; renderTasks(); });
document.getElementById('filt-done')?.addEventListener('click', () => { S.tasksFilter.state = 'DONE'; renderTasks(); });
document.getElementById('filt-fail')?.addEventListener('click', () => { S.tasksFilter.state = 'FAILED'; renderTasks(); });
document.getElementById('filt-review')?.addEventListener('click', () => { S.tasksFilter.state = 'REVIEW'; renderTasks(); });
document.getElementById('sort-dir')?.addEventListener('click', () => { S.tasksFilter.sortDir = S.tasksFilter.sortDir === 'desc' ? 'asc' : 'desc'; renderTasks(); });

renderAuthPanel();
if (!BC.requiresAuth) {
  void boot();
} else {
  const storedSec = storedSecret();
  if (storedSec) {
    void computeToken(storedSec).then((token) => {
      S.authToken = token;
      storeToken(token);
      void boot();
    }).catch(() => {
      clearSecret();
      renderAuthPanel();
    });
  }
}

// ── Bootstrap ──

async function boot() {
  try {
    const results = await Promise.allSettled([
      loadCoreSection('status', loadStatus),
      loadConfiguration(),
      loadCoreSection('providers', loadProviders),
      loadCoreSection('tasks', loadTasks),
      loadPlugins(),
      loadIntegrations(),
      loadAgents(),
      loadProjects(),
      loadOAuthApps(),
      loadPrompts(),
    ]);
    const unauthorized = results.some((r) => r.status === 'rejected' && isUnauthorized(r.reason));
    if (unauthorized) throw new Error('unauthorized');
    renderAll();

    if (S.tasks.length > 0) {
      const keepId = S.tasks.some((t) => t.taskId === S.selectedTaskId) ? S.selectedTaskId : S.tasks[0].taskId;
      void selectTask(keepId).catch((err) => {
        showActionToast('Failed to load task details: ' + (err instanceof Error ? err.message : 'Unknown'), true);
      });
    } else {
      renderDetail();
    }
  } catch (err) {
    if (isUnauthorized(err)) { clearToken(); clearSecret(); S.authToken = null; renderAuthPanel('Authentication failed. Re-enter ADMIN_AUTH_SECRET.'); }
  }
  connectGlobalStream();
}

async function loadCoreSection(section, loader) {
  try {
    await loader();
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    renderSectionLoadError(section, err);
  }
}

function renderSectionLoadError(section, err) {
  const sectionMessages = {
    status: 'Failed to load status',
    providers: 'Failed to load providers',
    tasks: 'Failed to load tasks',
  };
  const message = sectionMessages[section] || ('Failed to load ' + section);
  if (section === 'status' && el.statusBar) {
    el.statusBar.innerHTML = '<span class="topbar-stat"><strong>' + esc(message) + '</strong></span>';
    return;
  }
  if (section === 'providers') {
    const markup = '<div class="card" style="color:var(--danger)">' + esc(message) + '</div>';
    if (el.providersTicketing) el.providersTicketing.innerHTML = markup;
    if (el.providersReview) el.providersReview.innerHTML = markup;
    if (el.providersAgent) el.providersAgent.innerHTML = markup;
    if (el.providers) el.providers.innerHTML = markup;
    return;
  }
  if (section === 'tasks' && el.tasks) {
    el.tasks.innerHTML = '<div class="card" style="color:var(--danger)">' + esc(message) + '</div>';
    return;
  }
  showActionToast(message + ': ' + (err instanceof Error ? err.message : 'Unknown'), true);
}

// ── Loaders ──

async function loadStatus()    { S.status    = await adminFetch('/api/admin/status');                                renderStatusBar(); }
async function loadProviders() { const r = await adminFetch('/api/admin/providers'); S.providers = r.providers;     renderProviders(); renderStatusBar(); }
async function loadTasks()     { const r = await adminFetch('/api/admin/tasks');     S.tasks     = r.tasks;         renderTasks(); renderStatusBar(); }
async function loadPlugins()   { try { const r = await adminFetch('/api/admin/plugins'); S.plugins = r.plugins || []; } catch { S.plugins = []; } }
async function loadIntegrations() {
  try {
    const r = await adminFetch('/api/admin/integrations');
    S.integrations = r.integrations || [];
  } catch {
    S.integrations = [];
  }
  syncSelectedConfigurationItem();
  renderConfiguration();
}
async function loadAgents() {
  try {
    const r = await adminFetch('/api/admin/agents');
    S.agents = r.agents || [];
  } catch {
    S.agents = [];
  }
  renderConfiguration();
}
async function loadProjects() {
  try {
    const r = await adminFetch('/api/admin/projects');
    S.projects = r.projects || [];
  } catch {
    S.projects = [];
  }
  renderConfiguration();
}
async function loadOAuthApps() {
  try {
    const r = await adminFetch('/api/admin/oauth-apps');
    S.oAuthApps = r.apps || [];
  } catch {
    S.oAuthApps = [];
  }
  renderConfiguration();
}
async function loadConfiguration() {
  try {
    const r = await adminFetch('/api/admin/config');
    S.config = r.config;
  } catch {
    S.config = null;
  }
  renderConfiguration();
}
async function loadPrompts() {
  try {
    const r = await adminFetch('/api/admin/prompts');
    const prompts = r.prompts || [];
    // Load usage counts in parallel (best-effort)
    const usages = await Promise.allSettled(
      prompts.map(p => adminFetch('/api/admin/prompts/' + enc(p.id) + '/usage').then(u => ({ id: p.id, count: (u.agents || []).length })))
    );
    const usageMap = {};
    for (const u of usages) {
      if (u.status === 'fulfilled') usageMap[u.value.id] = u.value.count;
    }
    S.prompts = prompts.map(p => ({ ...p, usedByCount: usageMap[p.id] ?? 0 }));
  } catch { S.prompts = []; }
}

async function selectTask(id) {
  S.selectedTaskId = id;
  const [t, c, tr] = await Promise.all([
    adminFetch('/api/admin/tasks/' + enc(id)),
    adminFetch('/api/admin/tasks/' + enc(id) + '/cycles'),
    adminFetch('/api/admin/tasks/' + enc(id) + '/transitions'),
  ]);
  S.selectedTask = t.task;
  S.cycles       = c.cycles;
  S.transitions  = tr.transitions;
  renderTasks();
  renderDetail();
  connectLogsStream(id);
}

// ── Renderers ──

function renderAll() {
  renderStatusBar(); renderTasks(); renderProviders(); renderDetail(); renderConfiguration();
}

function switchView(view) {
  S.activeView = view;
  document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-nav') === view));
  document.querySelectorAll('.page-view').forEach((v) => v.classList.toggle('active', v.getAttribute('data-view') === view));
  if (view === 'configuration') renderConfiguration();
}

function renderStatusBar() {
  if (!el.statusBar) return;
  if (!S.status) { el.statusBar.innerHTML = ''; return; }
  const p = S.status.polling;
  const dotCls = p.running ? 'dot dot-ok' : 'dot dot-neutral';
  el.statusBar.innerHTML =
    '<span class="topbar-stat"><span class="' + dotCls + '"></span>&nbsp;<strong>' + esc(p.running ? 'Live' : 'Stopped') + '</strong></span>' +
    '<span class="topbar-stat"><strong>' + esc(String(S.tasks.length)) + '</strong>&nbsp;tasks</span>' +
    '<span class="topbar-stat"><strong>' + esc(String(S.providers.filter((pv) => pv.enabled && pv.category !== 'runtime').length)) + '</strong>&nbsp;providers</span>';
}

function renderTasks() {
  if (!el.tasks) return;
  // Sync filter button active states
  const stateMap = { 'filt-all': 'all', 'filt-run': 'AGENT_RUNNING', 'filt-rev': 'IN_REVIEW', 'filt-done': 'DONE', 'filt-fail': 'FAILED', 'filt-review': 'REVIEW' };
  Object.entries(stateMap).forEach(([id, val]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('is-active', S.tasksFilter.state === val);
  });
  const sortBtn = document.getElementById('sort-dir');
  if (sortBtn) sortBtn.textContent = S.tasksFilter.sortDir === 'desc' ? '↓' : '↑';

  const filtered = S.tasks.filter((task) => {
    if (S.tasksFilter.state === 'all') return true;
    if (S.tasksFilter.state === 'REVIEW') return (task.state || '').startsWith('REVIEW_');
    if (task.state !== S.tasksFilter.state) return false;
    return true;
  });

  const sorted = filtered.slice().sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return S.tasksFilter.sortDir === 'desc' ? bt - at : at - bt;
  });

  if (sorted.length === 0) {
    el.tasks.innerHTML = '<div class="card" style="color:var(--muted)">No tasks match the current filters.</div>';
    return;
  }
  el.tasks.innerHTML = sorted.map((task) => {
    const sel = task.taskId === S.selectedTaskId ? ' is-selected' : '';
    const taskOrigin = formatTaskOrigin(task);
    const taskTitle = task.ticketTitle || '\u2014';
    return (
      '<div class="task-row' + sel + '" data-id="' + esc(task.taskId) + '">' +
        '<div class="task-meta">' +
          '<div class="task-tags">' +
            (task.taskType === 'code-review' ? '<span class="badge" data-tone="neutral" style="font-size:10px">📝</span>' : '<span class="badge" data-tone="neutral" style="font-size:10px">⚙</span>') +
            (ticketLink(task)
              ? '<a href="' + esc(ticketLink(task)) + '" target="_blank" rel="noopener noreferrer" class="badge task-origin-badge badge-link">' + esc(taskOrigin) + '</a>'
              : '<span class="badge task-origin-badge">' + esc(taskOrigin) + '</span>') +
            (reviewLink(task)
              ? '<a href="' + esc(reviewLink(task)) + '" target="_blank" rel="noopener noreferrer" class="badge badge-link" data-tone="' + tone(task.state) + '">' + esc(task.state) + '</a>'
              : '<span class="badge" data-tone="' + tone(task.state) + '">' + esc(task.state) + '</span>') +
          '</div>' +
        '</div>' +
        '<div class="task-title">' + esc(taskTitle) + '</div>' +
      '</div>'
    );
  }).join('');
  el.tasks.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', () => void selectTask(row.getAttribute('data-id')));
  });
}

function renderTaskActionButtons() {
  return '' +
    '<div class="task-actions">' +
      '<button class="task-action-btn" data-action="pause" title="Pause task" aria-label="Pause task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true"><line x1="9" y1="6" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="18"/></svg></button>' +
      '<button class="task-action-btn" data-action="resume" title="Resume task" aria-label="Resume task"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true"><path d="M9 7.25v9.5c0 .61.68.98 1.2.66l7.1-4.75a.78.78 0 0 0 0-1.32l-7.1-4.75A.78.78 0 0 0 9 7.25Z"/></svg></button>' +
      '<button class="task-action-btn" data-action="retry" title="Retry task" aria-label="Retry task"><svg viewBox="-1 -1 26 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M18.5 6.5v4.5h-4.5"/></svg></button>' +
      '<button class="task-action-btn" data-action="abandon" title="Abandon task" aria-label="Abandon task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true"><path d="m8.5 8.5 7 7"/><path d="m15.5 8.5-7 7"/></svg></button>' +
      '<button class="task-action-btn" data-action="delete" title="Delete task from database" aria-label="Delete task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>' +
    '</div>';
}

function renderProviders() {
  if (!el.providers) return;
  if (S.providers.length === 0) {
    el.providers.innerHTML = '<div class="card" style="color:var(--muted)">No providers loaded.</div>';
    return;
  }

  const grouped = {
    ticketing: S.providers.filter((provider) => provider.category === 'ticketing'),
    review: S.providers.filter((provider) => provider.category === 'review'),
    agent: S.providers.filter((provider) => provider.category === 'agent'),
  };

  if (el.providersTicketing && el.providersReview && el.providersAgent) {
    el.providersTicketing.innerHTML = renderProviderCards(grouped.ticketing);
    el.providersReview.innerHTML = renderProviderCards(grouped.review);
    el.providersAgent.innerHTML = renderProviderCards(grouped.agent);
    return;
  }

  el.providers.innerHTML = renderProviderCards(S.providers);
}

function renderProviderCards(list) {
  return list.map((p) =>
    '<div class="card">' +
      '<div class="card-header">' +
        '<span class="card-title">' + esc(p.name) + '</span>' +
        '<span class="badge" data-tone="' + provTone(p.status) + '">' + esc(p.status) + '</span>' +
      '</div>' +
      '<div class="card-body">' + esc(p.category) + '</div>' +
    '</div>'
  ).join('') || '<div class="card" style="color:var(--muted)">No providers loaded.</div>';
}

function renderDetailMetaGrid(task) {
  const isReview  = task.taskType === 'code-review';
  const typeLabel = isReview ? '📝 Code Review' : '⚙ Code Gen';
  const reviewUrl = reviewLink(task);
  // Use gerritChangeId, or fall back to the first CPR change ID
  const changes = task.changesPerRepo || [];
  const displayChangeId = task.gerritChangeId
    || changes.find((c) => c.changeId)?.changeId
    || null;
  const reviewCard = reviewUrl
    ? '<div class="meta-card"><div class="meta-label">Review</div><div class="meta-value"><a href="' + esc(reviewUrl) + '" target="_blank" rel="noopener noreferrer" class="badge-link">' + esc(displayChangeId || reviewUrl) + '</a></div></div>'
    : metaCard('Review', displayChangeId || '\u2014');
  return '<div class="meta-grid">' +
    metaCard('Type',        typeLabel) +
    (!isReview ? metaCard('Ticket ID',   String(task.displayId || task.ticketId)) : '') +
    metaCard('Patchset',    String(task.currentPatchset)) +
    (isReview && task.reviewedPatchset ? metaCard('Reviewed PS', String(task.reviewedPatchset)) : '') +
    metaCard('Cycles',      String(task.cycleCount)) +
    metaCard('Updated',     fmt(task.updatedAt)) +
    metaCard('Created',     fmt(task.createdAt)) +
    reviewCard +
    metaCard('Failure',     task.failureReason || '\u2014') +
  '</div>';
}

function renderDetail() {
  if (!el.detail) return;
  if (!S.selectedTask) {
    el.detail.innerHTML = '<div class="empty-state">Select a task to inspect its cycles and transition timeline.</div>';
    return;
  }
  const task = S.selectedTask;
  const taskOrigin = formatTaskOrigin(task);
  const taskTitle = task.ticketTitle || '\u2014';
  const detailSubtitle = String(task.ticketSourceLabel || '').split(':')[0].toUpperCase();
  const detailDescription = task.ticketDescription || '\u2014';
  const imgBaseUrl = ticketLink(task) || BC.gitlabBaseUrl || null;
  const imgProxy = BC.gitlabBaseUrl ? '/api/admin/img-proxy?t=' + encodeURIComponent(S.authToken || '') + '&url=' : null;
  el.detail.innerHTML =
    '<div class="detail-head">' +
      '<div class="detail-head-actions">' +
        renderTaskActionButtons() +
        '<span class="badge" data-tone="' + tone(task.state) + '">' + esc(task.state) + '</span>' +
      '</div>' +
      (ticketLink(task)
        ? '<a href="' + esc(ticketLink(task)) + '" target="_blank" rel="noopener noreferrer" class="detail-origin">' + esc(taskOrigin) + '</a>'
        : '<span class="detail-origin">' + esc(taskOrigin) + '</span>') +
      '<span class="detail-title-text">' + esc(taskTitle) + '</span>' +
      '<div class="detail-subtitle">' + esc(detailSubtitle) + '</div>' +
      '<div class="detail-description">' + renderRichText(detailDescription, { baseUrl: imgBaseUrl, proxyPrefix: imgProxy }) + '</div>' +
    '</div>' +
    renderDetailMetaGrid(task) +
    '<div class="tabs">' +
      tabBtn('cycles',      'Agent Cycles') +
      tabBtn('transitions', 'State Timeline') +
    '</div>' +
    '<div class="tab-content' + (S.activeTab === 'cycles'      ? ' active' : '') + '" data-tab="cycles">'      + renderCycles()      + '</div>' +
    '<div class="tab-content' + (S.activeTab === 'transitions' ? ' active' : '') + '" data-tab="transitions">' + renderTransitions() + '</div>' +
    '<div class="logs-panel">' +
      '<div class="logs-panel-head"><span>Live Logs &amp; Metrics</span><button data-role="close-logs">\u2715</button></div>' +
      '<div class="metrics-summary" data-role="metrics-summary">' +
        '<div class="metric-item"><span class="metric-label">Active Tool</span><span class="metric-value" data-metric="active-tool">\u2014</span></div>' +
        '<div class="metric-item"><span class="metric-label">Tool Calls</span><span class="metric-value" data-metric="tool-calls">0</span></div>' +
        '<div class="metric-item"><span class="metric-label">Input Tokens</span><span class="metric-value" data-metric="input-tokens">0</span></div>' +
        '<div class="metric-item"><span class="metric-label">Output Tokens</span><span class="metric-value" data-metric="output-tokens">0</span></div>' +
        '<div class="metric-item"><span class="metric-label">Cache Read</span><span class="metric-value" data-metric="cache-read">0</span></div>' +
        '<div class="metric-item"><span class="metric-label">Cache Write</span><span class="metric-value" data-metric="cache-write">0</span></div>' +
        '<div class="metric-item"><span class="metric-label">Quota</span><span class="metric-value unavailable" data-metric="quota">Not exposed</span></div>' +
      '</div>' +
      '<div class="logs-filters" data-role="logs-filters">' +
        '<button class="logs-filter-btn active" data-filter="all">All</button>' +
        '<button class="logs-filter-btn" data-filter="tools">Tools</button>' +
        '<button class="logs-filter-btn" data-filter="usage">Usage</button>' +
        '<button class="logs-filter-btn" data-filter="errors">Errors</button>' +
        '<button class="logs-filter-btn" data-filter="review">Review</button>' +
      '</div>' +
      '<div class="logs-output" data-role="logs-output"><div class="log-entry">Waiting for logs...</div></div>' +
    '</div>';

  el.detail.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      S.activeTab = t.getAttribute('data-tab');
      el.detail.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      el.detail.querySelectorAll('.tab-content').forEach((x) => x.classList.toggle('active', x.getAttribute('data-tab') === S.activeTab));
    });
  });

  el.detail.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => void onActionClick(btn.getAttribute('data-action'), task.taskId, btn));
  });

  el.detail.querySelector('[data-role="close-logs"]')?.addEventListener('click', () => disconnectLogsStream());

  // Wire up filter buttons
  el.detail.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.logsFilter = btn.getAttribute('data-filter') || 'all';
      el.detail.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      applyLogsFilter();
    });
  });
}

function readEventStr(data, keys) {
  if (!data || typeof data !== 'object') return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const wrapper of ['toolCall', 'tool', 'function', 'data', 'toolUse']) {
    const nested = data[wrapper];
    if (!nested || typeof nested !== 'object') continue;
    for (const key of keys) {
      const value = nested[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    for (const inner of ['toolCall', 'tool', 'function', 'data', 'toolUse']) {
      const nestedInner = nested[inner];
      if (!nestedInner || typeof nestedInner !== 'object') continue;
      for (const key of keys) {
        const value = nestedInner[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
    }
  }
  return null;
}

function readEventNum(data, keys) {
  if (!data || typeof data !== 'object') return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  for (const wrapper of ['usage', 'data', 'metrics', 'tokenUsage']) {
    const nested = data[wrapper];
    if (!nested || typeof nested !== 'object') continue;
    for (const key of keys) {
      const value = nested[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function readToolInput(data) {
  if (!data || typeof data !== 'object') return {};
  const direct = data.input;
  if (direct && typeof direct === 'object') return direct;
  const directArgs = data.arguments;
  if (directArgs && typeof directArgs === 'object') return directArgs;
  for (const wrapper of ['toolCall', 'tool', 'function', 'toolUse', 'data']) {
    const nested = data[wrapper];
    if (!nested || typeof nested !== 'object') continue;
    if (nested.input && typeof nested.input === 'object') return nested.input;
    if (nested.arguments && typeof nested.arguments === 'object') return nested.arguments;
    if (nested.function && typeof nested.function === 'object') {
      if (nested.function.input && typeof nested.function.input === 'object') return nested.function.input;
      if (nested.function.arguments && typeof nested.function.arguments === 'object') return nested.function.arguments;
    }
  }
  return {};
}

function renderDetailTableRows(data, fields) {
  return fields
    .filter(([key]) => readEventStr(data, [key]) !== null || readEventNum(data, [key]) !== null)
    .map(([key, label]) => {
      const numValue = readEventNum(data, [key]);
      const value = numValue !== null ? String(numValue) : readEventStr(data, [key]);
      return '<tr><td class="log-detail-key">' + esc(label) + '</td>' +
        '<td class="log-detail-val">' + esc(String(value)) + '</td></tr>';
    })
    .join('');
}

function updateCumulativeTokenUsage(tokenUsage, data) {
  const inputTokens = readEventNum(data, ['inputTokens', 'input_tokens', 'promptTokens']);
  const outputTokens = readEventNum(data, ['outputTokens', 'output_tokens', 'completionTokens']);
  const cacheReadTokens = readEventNum(data, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens']);
  const cacheWriteTokens = readEventNum(data, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens']);
  const totalTokens = readEventNum(data, ['totalTokens', 'total_tokens', 'tokens']);

  if (inputTokens !== null) tokenUsage.inputTokens = Math.max(tokenUsage.inputTokens, inputTokens);
  if (outputTokens !== null) tokenUsage.outputTokens = Math.max(tokenUsage.outputTokens, outputTokens);
  if (cacheReadTokens !== null) tokenUsage.cacheReadTokens = Math.max(tokenUsage.cacheReadTokens, cacheReadTokens);
  if (cacheWriteTokens !== null) tokenUsage.cacheWriteTokens = Math.max(tokenUsage.cacheWriteTokens, cacheWriteTokens);

  const derivedTotal = tokenUsage.inputTokens + tokenUsage.outputTokens;
  tokenUsage.totalTokens = totalTokens !== null
    ? Math.max(tokenUsage.totalTokens, totalTokens, derivedTotal)
    : Math.max(tokenUsage.totalTokens, derivedTotal);
}

function deriveCycleDurationMs(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const startEvent = events.find((event) => event && event.type === 'session.start' && event.timestamp);
  const endEvent = [...events].reverse().find((event) => event && event.type === 'session.end' && event.timestamp);
  if (!startEvent || !endEvent) return null;

  const startMs = Date.parse(startEvent.timestamp);
  const endMs = Date.parse(endEvent.timestamp);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function formatDurationShort(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return Math.round(durationMs) + 'ms';

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's';
  }
  if (minutes > 0) {
    return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  }
  return seconds + 's';
}

function renderCycles() {
  if (S.cycles.length === 0) return '<div class="card" style="color:var(--muted)">No cycles recorded yet.</div>';
  return S.cycles.map((c) => {
    const isReviewCycle = c.result.metadata && c.result.metadata.reviewMode === true;
    if (isReviewCycle) return renderReviewCycle(c);
    return renderCodegenCycle(c);
  }).join('');
}

function renderReviewCycle(c) {
  const meta = c.result.metadata || {};
  const comments = Array.isArray(meta.comments) ? meta.comments : [];
  const vote = typeof meta.vote === 'number' ? meta.vote : null;
  const patchset = typeof meta.patchset === 'number' ? meta.patchset : null;
  const events = c.result.agentEvents || [];
  const cycleDurationMs = deriveCycleDurationMs(events);

  const voteLabel = vote !== null ? (vote > 0 ? '+' + vote : String(vote)) : '\u2014';
  const voteTone = vote !== null ? (vote > 0 ? 'ok' : 'bad') : 'neutral';

  const metricsHtml =
    '<div class="cycle-metrics-inline">' +
      (patchset !== null ? '<span>📋 PS ' + esc(String(patchset)) + '</span>' : '') +
      '<span>💬 ' + esc(String(comments.length)) + ' comment' + (comments.length !== 1 ? 's' : '') + '</span>' +
      '<span class="badge" data-tone="' + voteTone + '" style="font-size:11px;padding:1px 6px">Vote: ' + esc(voteLabel) + '</span>' +
      (cycleDurationMs !== null ? '<span>⏱ ' + esc(formatDurationShort(cycleDurationMs)) + '</span>' : '') +
    '</div>';

  const commentsHtml = comments.length > 0
    ? '<div style="margin-top:12px;font-size:12px;font-weight:bold;color:var(--text)">Review Comments</div>' +
      '<div class="review-comments">' + comments.map((rc) =>
        '<div class="review-comment">' +
          '<div class="review-comment-header">' +
            '<span class="review-comment-file">' + esc(rc.file || '?') + ':' + esc(String(rc.line || '?')) + '</span>' +
            '<span class="badge" data-tone="' + (rc.severity === 'error' ? 'bad' : rc.severity === 'warning' ? 'warn' : 'neutral') + '" style="font-size:10px;padding:0 4px">' + esc(rc.severity || '?') + '</span>' +
          '</div>' +
          '<div class="review-comment-body">' + esc(rc.message || '') + '</div>' +
        '</div>'
      ).join('') + '</div>'
    : '';

  const reviewCycleTs = c.createdAt ? ' <span style="font-size:11px;color:var(--muted)">' + esc(fmt(c.createdAt)) + '</span>' : '';

  return '<div class="card">' +
    '<div class="card-header">' +
      '<span class="card-title">Review Cycle ' + esc(String(c.cycleNumber)) + reviewCycleTs + '</span>' +
      '<span class="badge" data-tone="' + tone(c.result.status) + '">' + esc(c.result.status) + '</span>' +
    '</div>' +
    '<div class="card-body">' +
      '<div class="cycle-column">' +
        '<div class="cycle-col-label">Summary</div>' +
        '<div class="cycle-rich-text cycle-panel">' + renderRichText(c.result.summary || '\u2014') + '</div>' +
      '</div>' +
      metricsHtml +
      commentsHtml +
    '</div>' +
  '</div>';
}

function renderCodegenCycle(c) {
    const modifiedFiles = c.result.modifiedFiles || [];
    const commitShaSuffix = c.result.commitSha ? ' [' + esc(c.result.commitSha.slice(0, 8)) + ']' : '';
    const events = c.result.agentEvents || [];
    const cycleDurationMs = deriveCycleDurationMs(events);

    const toolStartEvents = events.filter((e) => e.type === 'tool.execution_start');
    const usageEvents = events.filter((e) => e.type === 'assistant.usage' || e.type === 'session.usage_info');
    const tokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

    for (const e of usageEvents) {
      updateCumulativeTokenUsage(tokenUsage, e.data || null);
    }

    const metricsHtml = (cycleDurationMs !== null || toolStartEvents.length || tokenUsage.totalTokens || tokenUsage.inputTokens || tokenUsage.outputTokens || tokenUsage.cacheReadTokens)
      ? '<div class="cycle-metrics-inline">' +
          (cycleDurationMs !== null ? '<span>⏱ ' + esc(formatDurationShort(cycleDurationMs)) + '</span>' : '') +
          (toolStartEvents.length ? '<span>🔧 ' + esc(String(toolStartEvents.length)) + ' tool call' + (toolStartEvents.length === 1 ? '' : 's') + '</span>' : '') +
          (tokenUsage.totalTokens ? '<span>🪙 ' + formatTokenCount(tokenUsage.totalTokens) + ' total</span>' : '') +
          (tokenUsage.inputTokens ? '<span>📥 ' + formatTokenCount(tokenUsage.inputTokens) + ' in</span>' : '') +
          (tokenUsage.outputTokens ? '<span>📤 ' + formatTokenCount(tokenUsage.outputTokens) + ' out</span>' : '') +
          (tokenUsage.cacheReadTokens ? '<span>⚡ ' + formatTokenCount(tokenUsage.cacheReadTokens) + ' cache</span>' : '') +
        '</div>'
      : '';

    const cycleTs = c.createdAt ? ' <span style="font-size:11px;color:var(--muted)">' + esc(fmt(c.createdAt)) + '</span>' : '';

    return '<div class="card">' +
      '<div class="card-header">' +
        '<span class="card-title">Cycle ' + esc(String(c.cycleNumber)) + commitShaSuffix + cycleTs + '</span>' +
        '<span class="badge" data-tone="' + tone(c.result.status) + '">' + esc(c.result.status) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="cycle-columns">' +
          '<div class="cycle-column">' +
            '<div class="cycle-col-label">Agent Response</div>' +
            '<div class="cycle-rich-text cycle-panel">' + renderRichText(c.result.summary || '—') + '</div>' +
          '</div>' +
        '</div>' +
        metricsHtml +
        (modifiedFiles.length
          ? '<div style="margin-top:12px;font-size:12px;font-weight:bold;color:var(--text)">Files</div>' +
            '<ul class="file-list">' + modifiedFiles.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>'
          : '') +
      '</div>' +
    '</div>';
}

function formatTaskOrigin(task) {
  const raw = String(task.ticketSourceLabel || 'ticket');
  const sourceType = raw.split(':')[0].toUpperCase();
  return sourceType + ': #' + (task.displayId || task.ticketId);
}

function renderTransitions() {
  if (S.transitions.length === 0) return '<div class="card" style="color:var(--muted)">No transitions captured yet.</div>';
  return S.transitions.map((t) =>
    '<div class="card">' +
      '<div class="card-header">' +
        '<span class="card-title">' + esc(t.fromState) + ' \u2192 ' + esc(t.toState) + '</span>' +
        '<span style="color:var(--muted);font-size:11px">' + esc(fmt(t.createdAt)) + '</span>' +
      '</div>' +
      '<div class="card-body" style="word-break:break-all">' + esc(JSON.stringify(t.metadata)) + '</div>' +
    '</div>'
  ).join('');
}

function renderAuthPanel(msg) {
  if (!el.auth) return;
  if (!BC.requiresAuth) {
    el.auth.innerHTML = '';
    if (el.authStatus) el.authStatus.textContent = '';
    return;
  }
  if (S.authToken) {
    el.auth.innerHTML = '';
    if (el.authStatus) el.authStatus.textContent = 'Authenticated';
    if (el.authError && msg) el.authError.textContent = msg;
    return;
  }
  if (el.authStatus) el.authStatus.textContent = 'Auth required';
  if (el.authError)  el.authError.textContent  = msg || '';
  el.auth.innerHTML =
    '<form class="auth-form" data-role="auth-form">' +
      '<div class="card-body">Enter your <code>ADMIN_AUTH_SECRET</code> to unlock the dashboard.</div>' +
      '<input type="password" name="secret" placeholder="Enter ADMIN_AUTH_SECRET" autocomplete="current-password" />' +
      '<button type="submit" class="primary">Unlock dashboard</button>' +
    '</form>';
  el.auth.querySelector('[data-role="auth-form"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const secret = new FormData(e.currentTarget).get('secret')?.toString().trim() || '';
    if (!secret) { if (el.authError) el.authError.textContent = 'Secret required.'; return; }
    // Compute HMAC-SHA256 bearer token client-side: "<timestamp>.<hex_signature>"
    let token;
    try {
      const ts = Math.floor(Date.now() / 1000).toString();
      const keyData = new TextEncoder().encode(secret);
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(ts));
      const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
      token = ts + '.' + hex;
    } catch {
      if (el.authError) el.authError.textContent = 'Failed to compute token.';
      return;
    }
    storeSecret(secret);
    storeToken(token);
    S.authToken = token;
    if (el.authError) el.authError.textContent = '';
    try { await boot(); renderAuthPanel(); }
    catch { clearToken(); S.authToken = null; renderAuthPanel('Invalid secret.'); }
  });
}

function renderConfiguration() {
  renderConfigurationShell();
}

function renderConfigurationShell() {
  renderConfigurationNav();
  renderConfigurationHeader();
  renderConfigurationToolbar();
  renderConfigurationSection();
}

function renderConfigurationNav() {
  if (!el.configurationNav) return;
  const sections = configurationSections();
  el.configurationNav.innerHTML =
    '<div class="configuration-nav-head">' +
      '<div class="configuration-nav-kicker">Admin</div>' +
      '<div class="configuration-nav-title">Configuration</div>' +
    '</div>' +
    sections.map((section) =>
      '<button class="configuration-nav-item' +
        (S.configurationSection === section.id ? ' active' : '') +
        (section.comingSoon ? ' coming-soon' : '') +
        '" data-config-section="' + esc(section.id) + '">' +
        '<span class="configuration-nav-label">' + esc(section.label) + '</span>' +
        '<span class="configuration-nav-meta">' + esc(section.meta) + '</span>' +
      '</button>'
    ).join('');

  el.configurationNav.querySelectorAll('[data-config-section]').forEach((item) => {
    item.addEventListener('click', () => setConfigurationSection(item.getAttribute('data-config-section')));
  });
}

function renderConfigurationHeader() {
  if (!el.configurationHeader) return;
  const section = getConfigurationSectionMeta();
  const isCategorySection = ['tickets', 'code-review', 'agents'].includes(S.configurationSection);
  const title = isCategorySection ? section.label : section.label;
  const countLabel = isCategorySection
    ? String(getFilteredIntegrations().length) + ' shown'
    : section.meta;
  el.configurationHeader.innerHTML =
    '<div class="configuration-breadcrumb">Configuration / ' + esc(title) + '</div>' +
    '<div class="configuration-title-row">' +
      '<div class="configuration-title">' + esc(title) + '</div>' +
      '<div class="configuration-toolbar-meta">' + esc(countLabel) + '</div>' +
    '</div>' +
    '<div class="configuration-description">' + esc(section.description) + '</div>';
}

function renderConfigurationToolbar() {
  if (!el.configurationToolbar) return;
  const isCategorySection = ['tickets', 'code-review', 'agents'].includes(S.configurationSection);
  if (isCategorySection) {
    el.configurationToolbar.innerHTML =
      '<div class="configuration-toolbar-group">' +
        '<input class="configuration-toolbar-search" data-role="configuration-search" type="search" placeholder="Search integrations" value="' + esc(S.configurationSearch) + '" />' +
        '<select data-role="configuration-filter">' +
          filterOption('all', 'All statuses') +
          filterOption('active', 'Active only') +
          filterOption('enabled', 'Enabled only') +
          filterOption('disabled', 'Disabled only') +
        '</select>' +
      '</div>' +
      '<div class="configuration-toolbar-group">' +
        '<button class="primary" data-role="add-integration">+ Add Integration</button>' +
      '</div>';

    el.configurationToolbar.querySelector('[data-role="configuration-search"]')?.addEventListener('input', (event) => {
      S.configurationSearch = event.currentTarget.value || '';
      renderConfiguration();
    });
    el.configurationToolbar.querySelector('[data-role="configuration-filter"]')?.addEventListener('change', (event) => {
      S.configurationFilters.status = event.currentTarget.value || 'all';
      renderConfiguration();
    });
    el.configurationToolbar.querySelector('[data-role="add-integration"]')?.addEventListener('click', () => void showAddIntegrationModal(S.configurationSection));
    return;
  }

  if (S.configurationSection === 'agents-library') {
    el.configurationToolbar.innerHTML =
      '<div class="configuration-toolbar-group">' +
        '<span class="configuration-toolbar-meta">' + String(S.agents.length) + ' agent(s)</span>' +
      '</div>' +
      '<div class="configuration-toolbar-group">' +
        '<button class="primary" data-role="add-agent">+ New Agent</button>' +
      '</div>';
    el.configurationToolbar.querySelector('[data-role="add-agent"]')?.addEventListener('click', () => showAgentModal(null));
    return;
  }

  if (S.configurationSection === 'projects') {
    el.configurationToolbar.innerHTML =
      '<div class="configuration-toolbar-group">' +
        '<span class="configuration-toolbar-meta">' + String(S.projects.length) + ' project(s)</span>' +
      '</div>' +
      '<div class="configuration-toolbar-group">' +
        '<button class="primary" data-role="add-project">+ New Project</button>' +
      '</div>';
    el.configurationToolbar.querySelector('[data-role="add-project"]')?.addEventListener('click', () => showProjectModal(null));
    return;
  }

  if (S.configurationSection === 'oauth-apps') {
    el.configurationToolbar.innerHTML =
      '<div class="configuration-toolbar-group">' +
        '<span class="configuration-toolbar-meta">' + String(S.oAuthApps.length) + ' app(s)</span>' +
      '</div>' +
      '<div class="configuration-toolbar-group">' +
        '<button class="primary" data-role="add-oauth-app">+ New OAuth App</button>' +
      '</div>';
    el.configurationToolbar.querySelector('[data-role="add-oauth-app"]')?.addEventListener('click', () => showOAuthAppModal());
    return;
  }

  el.configurationToolbar.innerHTML =
    '<div class="configuration-toolbar-group">' +
      '<span class="configuration-toolbar-meta">Section ready for incremental expansion.</span>' +
    '</div>';
}

function renderConfigurationSection() {
  if (!el.configurationContent) return;
  if (['tickets', 'code-review', 'agents'].includes(S.configurationSection)) {
    renderIntegrationsTable();
    return;
  }
  if (S.configurationSection === 'agents-library') {
    renderAgentsLibrary();
    return;
  }
  if (S.configurationSection === 'projects') {
    renderProjectsSection();
    return;
  }
  if (S.configurationSection === 'oauth-apps') {
    renderOAuthAppsConfigSection();
    return;
  }
  if (S.configurationSection === 'system-settings') {
    renderSystemSettingsView();
    return;
  }
  if (S.configurationSection === 'overview') {
    renderConfigurationOverview();
    return;
  }
  if (S.configurationSection === 'prompts') {
    renderPromptsConfigSection();
    return;
  }
  el.configurationContent.innerHTML = renderComingSoonSection(S.configurationSection);
}


function showPromptsModal(promptId) {
  closePromptsModal();
  const overlay = document.createElement('div');
  overlay.id = 'prompts-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  
  const isEdit = !!promptId;
  const prompt = isEdit ? S.prompts.find((p) => p.id === promptId) : null;
  
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;width:90%;max-width:500px;box-shadow:0 8px 32px rgba(0,0,0,0.2)';
  
  const title = document.createElement('h3');
  title.textContent = isEdit ? 'Edit Prompt' : 'New Prompt';
  title.style.margin = '0 0 16px 0';
  modal.appendChild(title);
  
  if (!isEdit) {
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Prompt Name';
    nameLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px';
    modal.appendChild(nameLabel);
    
    const nameInput = document.createElement('input');
    nameInput.id = 'prompt-name-input';
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. code-review, custom-format';
    nameInput.style.cssText = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);margin-bottom:12px;box-sizing:border-box';
    modal.appendChild(nameInput);
  } else {
    const idLabel = document.createElement('label');
    idLabel.textContent = 'Prompt ID (read-only)';
    idLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px';
    modal.appendChild(idLabel);
    
    const idField = document.createElement('div');
    idField.textContent = promptId;
    idField.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);margin-bottom:12px;font-family:monospace;font-size:12px';
    modal.appendChild(idField);
  }
  
  const contentLabel = document.createElement('label');
  contentLabel.textContent = 'Prompt Content';
  contentLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px';
  modal.appendChild(contentLabel);
  
  const textarea = document.createElement('textarea');
  textarea.id = 'prompt-content-input';
  textarea.placeholder = 'Enter prompt content...';
  textarea.value = prompt?.content || '';
  textarea.style.cssText = 'width:100%;height:200px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:ui-monospace,"SF Mono",monospace;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:12px';
  modal.appendChild(textarea);
  
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:12px';
  cancelBtn.onclick = closePromptsModal;
  actions.appendChild(cancelBtn);
  
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:6px;background:var(--accent);color:var(--accent-text);cursor:pointer;font-size:12px;font-weight:600';
  saveBtn.onclick = async () => {
    const content = textarea.value.trim();
    if (!content) {
      alert('Content cannot be empty');
      return;
    }
    if (isEdit) {
      await updatePrompt(promptId, content);
    } else {
      const nameInput = document.getElementById('prompt-name-input');
      const label = nameInput?.value?.trim();
      if (!label) {
        alert('Prompt name cannot be empty');
        return;
      }
      await createPrompt(label, content);
    }
  };
  actions.appendChild(saveBtn);
  modal.appendChild(actions);
  
  overlay.appendChild(modal);
  overlay.onclick = (e) => {
    if (e.target === overlay) closePromptsModal();
  };
  document.body.appendChild(overlay);
  
  setTimeout(() => {
    if (isEdit) {
      textarea.focus();
    } else {
      const nameInput = document.getElementById('prompt-name-input');
      if (nameInput) nameInput.focus();
    }
  }, 0);
}

function closePromptsModal() {
  const modal = document.getElementById('prompts-modal');
  if (modal) modal.remove();
}

async function createPrompt(label, content) {
  try {
    const r = await adminFetch('/api/admin/prompts', 'POST', JSON.stringify({ label, content }));
    if (r.prompt) {
      closePromptsModal();
      showActionToast('Prompt created', false);
      await loadPrompts();
      renderConfiguration();
    }
  } catch (err) {
    showActionToast('Error creating prompt: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function updatePrompt(id, content) {
  try {
    await adminFetch('/api/admin/prompts/' + enc(id), 'PUT', JSON.stringify({ content }));
    closePromptsModal();
    showActionToast('Prompt updated', false);
    await loadPrompts();
    renderConfiguration();
  } catch (err) {
    showActionToast('Error updating prompt: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function deletePrompt(id) {
  if (!confirm('Delete prompt "' + id + '"? This cannot be undone.')) return;
  try {
    await adminFetch('/api/admin/prompts/' + enc(id), 'DELETE');
    showActionToast('Prompt deleted', false);
    await loadPrompts();
    renderConfiguration();
  } catch (err) {
    showActionToast('Error deleting prompt: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

function renderPromptsConfigSection() {
  if (!el.configurationContent) return;
  
  const BUILT_IN_PROMPT_IDS = new Set([
    'system_gerrit_code', 'system_gitlab_code',
    'system_gerrit_review', 'system_gitlab_review',
    'user_gerrit_review', 'user_gitlab_review',
  ]);

  const rows = S.prompts.map((prompt) => {
    const isBuiltIn = BUILT_IN_PROMPT_IDS.has(prompt.id);
    const isDeletable = !isBuiltIn;

    // All prompts are editable
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.cssText = 'padding:4px 8px;margin-right:4px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer;font-size:11px';
    editBtn.onclick = () => showPromptsModal(prompt.id);
    
    let deleteBtn = null;
    if (isDeletable) {
      deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--danger-border,var(--border));border-radius:4px;background:transparent;color:var(--danger,var(--text));cursor:pointer;font-size:11px';
      deleteBtn.onclick = () => deletePrompt(prompt.id);
    }
    
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border)';
    
    const info = document.createElement('div');
    info.style.cssText = 'flex:1';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:13px;font-weight:600;color:var(--text)';
    const badge = isBuiltIn ? '[built-in] ' : '';
    label.textContent = badge + (prompt.label || prompt.id);
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px';
    const usageText = prompt.usedByCount > 0 ? ' \xB7 used by ' + prompt.usedByCount + ' agent' + (prompt.usedByCount === 1 ? '' : 's') : '';
    meta.textContent = prompt.content.length + ' chars' + usageText;
    info.appendChild(label);
    info.appendChild(meta);
    row.appendChild(info);
    
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px';
    actions.appendChild(editBtn);
    if (deleteBtn) actions.appendChild(deleteBtn);
    row.appendChild(actions);
    
    return row;
  });
  
  el.configurationContent.innerHTML = '';
  
  const panel = document.createElement('div');
  panel.style.cssText = 'display:flex;flex-direction:column;height:100%';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:18px;font-weight:600;color:var(--text)';
  title.textContent = 'Prompts';
  const newBtn = document.createElement('button');
  newBtn.textContent = '+ New Prompt';
  newBtn.style.cssText = 'padding:6px 12px;background:var(--accent);color:var(--accent-text);border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600';
  newBtn.onclick = () => showPromptsModal();
  header.appendChild(title);
  header.appendChild(newBtn);
  panel.appendChild(header);
  
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto';
  
  if (S.prompts.length === 0) {
    const note = document.createElement('div');
    note.style.cssText = 'padding:16px;color:var(--muted);text-align:center';
    note.textContent = 'No prompts yet. Click "+ New Prompt" to create one.';
    body.appendChild(note);
  } else {
    rows.forEach((row) => body.appendChild(row));
  }
  
  panel.appendChild(body);
  el.configurationContent.appendChild(panel);
}

function showOAuthAppModal(existingApp) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
      '<h3>' + esc(existingApp ? 'Edit OAuth App' : 'New OAuth App') + '</h3>' +
      '<label>Provider</label>' +
      '<input data-role="oauth-app-provider" placeholder="e.g. gitlab" value="' + esc(existingApp?.provider || 'gitlab') + '" />' +
      '<label>Base URL</label>' +
      '<input data-role="gitlab-oauth-base-url" placeholder="https://gitlab.example.com" value="' + esc(existingApp?.baseUrl || '') + '" />' +
      '<label>OAuth Client ID</label>' +
      '<input data-role="gitlab-oauth-client-id" placeholder="OAuth application client id" value="' + esc(existingApp?.clientId || '') + '" />' +
      '<div class="configuration-panel-note" style="margin-top:12px">This registry lets integrations connect with just a base URL. VE resolves the client id from this list before starting OAuth.</div>' +
      '<div class="modal-actions">' +
        '<button data-role="modal-cancel">Cancel</button>' +
        '<button class="primary" data-role="modal-save">Save</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector('[data-role="modal-cancel"]')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('[data-role="modal-save"]')?.addEventListener('click', async () => {
    const provider = overlay.querySelector('[data-role="oauth-app-provider"]')?.value?.trim() || 'gitlab';
    const baseUrl = overlay.querySelector('[data-role="gitlab-oauth-base-url"]')?.value?.trim();
    const clientId = overlay.querySelector('[data-role="gitlab-oauth-client-id"]')?.value?.trim();
    if (!baseUrl || !clientId) {
      showActionToast('Base URL and client id are required', true);
      return;
    }

    try {
      await adminFetch('/api/admin/oauth-apps', 'POST', JSON.stringify({ provider, baseUrl, clientId }));
      overlay.remove();
      await loadOAuthApps();
      showActionToast(existingApp ? 'OAuth app updated' : 'OAuth app created', false);
    } catch (err) {
      showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
    }
  });
}

async function deleteOAuthApp(provider, baseUrl) {
  if (!confirm('Delete OAuth app for ' + provider + ': ' + baseUrl + '?')) return;
  try {
    await adminFetch('/api/admin/oauth-apps', 'DELETE', JSON.stringify({ provider, baseUrl }));
    await loadOAuthApps();
    showActionToast('OAuth app deleted', false);
  } catch (err) {
    showActionToast('Error deleting OAuth app: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

function renderOAuthAppsConfigSection() {
  if (!el.configurationContent) return;

  el.configurationContent.innerHTML = '';

  const panel = document.createElement('div');
  panel.style.cssText = 'display:flex;flex-direction:column;height:100%';

  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:18px;font-weight:600;color:var(--text)';
  title.textContent = 'OAuth Apps';
  header.appendChild(title);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto';

  if (S.oAuthApps.length === 0) {
    const note = document.createElement('div');
    note.style.cssText = 'padding:16px;color:var(--muted);text-align:center';
    note.textContent = 'No OAuth apps configured. Add one to enable URL-only OAuth connect flows.';
    body.appendChild(note);
  } else {
    S.oAuthApps.forEach((app) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;font-weight:600;color:var(--text)';
      label.textContent = app.provider + ': ' + app.baseUrl;
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px';
      meta.textContent = 'Client ID: ' + app.clientId;
      info.appendChild(label);
      info.appendChild(meta);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:4px';
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer;font-size:11px';
      editBtn.onclick = () => showOAuthAppModal(app);
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--danger-border,var(--border));border-radius:4px;background:transparent;color:var(--danger,var(--text));cursor:pointer;font-size:11px';
      deleteBtn.onclick = () => { void deleteOAuthApp(app.provider, app.baseUrl); };
      actions.appendChild(deleteBtn);
      row.appendChild(actions);

      body.appendChild(row);
    });
  }

  panel.appendChild(body);
  el.configurationContent.appendChild(panel);
}

function overviewCategoryRows(category, targetSection) {
  const all = S.integrations.filter((i) => i.category === category);
  const active = all.filter((i) => i.active === true).length;
  return all.map((integration) =>
    '<div class="overview-integration-row" data-overview-integration-id="' + esc(integration.id) + '" data-overview-category="' + esc(category) + '">' +
      '<span class="overview-integration-name">' + esc(integration.name) + '</span>' +
      '<span class="overview-integration-type">' + esc(integration.type) + '</span>' +
      '<span class="badge" data-tone="' + integrationTone(integration) + '">' + esc(integrationStatusLabel(integration)) + '</span>' +
    '</div>'
  ).join('') || '<div class="configuration-panel-note">No integrations in this category.</div>';
}

function renderConfigurationOverview() {
  if (!el.configurationContent) return;
  const tickets    = S.integrations.filter((i) => i.category === 'ticketing');
  const vcs        = S.integrations.filter((i) => i.category === 'review');
  const agents     = S.integrations.filter((i) => i.category === 'agent');
  const totalIntegrations = S.integrations.length;
  const activeIntegrations = S.integrations.filter((i) => i.active === true).length;

  el.configurationContent.innerHTML =
    '<div class="configuration-summary-grid">' +
      summaryCard('Total', String(totalIntegrations)) +
      summaryCard('Active', String(activeIntegrations)) +
    '</div>' +
    '<div class="configuration-drawer-panel" style="margin-top:12px">' +
      '<div class="configuration-drawer-panel-title">Runtime Configuration</div>' +
      '<div class="config-grid">' + renderSettingRows(getSystemSettingsRows()) + '</div>' +
    '</div>' +
    '<div class="configuration-drawer-panel" style="margin-top:12px">' +
      '<div class="configuration-drawer-panel-title">Ticket Integrations (' + String(tickets.filter((i) => i.active).length) + ' active / ' + String(tickets.length) + ' total)</div>' +
      '<div class="overview-integration-table" data-overview-section="tickets">' + overviewCategoryRows('ticketing', 'tickets') + '</div>' +
    '</div>' +
    '<div class="configuration-drawer-panel" style="margin-top:12px">' +
      '<div class="configuration-drawer-panel-title">Code Review Integrations (' + String(vcs.filter((i) => i.active).length) + ' active / ' + String(vcs.length) + ' total)</div>' +
      '<div class="overview-integration-table" data-overview-section="code-review">' + overviewCategoryRows('review', 'code-review') + '</div>' +
    '</div>' +
    '<div class="configuration-drawer-panel" style="margin-top:12px">' +
      '<div class="configuration-drawer-panel-title">Agent Integrations (' + String(agents.filter((i) => i.active).length) + ' active / ' + String(agents.length) + ' total)</div>' +
      '<div class="overview-integration-table" data-overview-section="agents">' + overviewCategoryRows('agent', 'agents') + '</div>' +
    '</div>';

  el.configurationContent.querySelectorAll('[data-overview-integration-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const category = row.getAttribute('data-overview-category') || 'ticketing';
      const section = category === 'review' ? 'code-review' : category === 'agent' ? 'agents' : 'tickets';
      setConfigurationSection(section);
      selectConfigurationItem(row.getAttribute('data-overview-integration-id'));
    });
  });
}

function categoryEmptyStateMessage() {
  if (S.configurationSection === 'tickets')     return 'No ticket source integrations configured. Click Add to connect Redmine, GitLab Issues, or GitHub Issues.';
  if (S.configurationSection === 'code-review') return 'No code review integrations configured. Click Add to connect Gerrit, GitLab MR, or GitHub Pull Requests.';
  if (S.configurationSection === 'agents')      return 'No agent integrations configured. Click Add to connect Copilot, Claude, or Ollama.';
  return 'No integrations configured.';
}

function renderIntegrationsTable() {
  if (!el.configurationContent) return;
  const integrations = getFilteredIntegrations();
  if (integrations.length === 0) {
    el.configurationContent.innerHTML =
      '<div class="resource-table" data-role="config-integrations-table">' +
        '<div class="integration-empty">' + esc(categoryEmptyStateMessage()) + '</div>' +
      '</div>';
    return;
  }

  el.configurationContent.innerHTML =
    '<div class="resource-table" data-role="config-integrations-table">' +
      '<div class="resource-table-head">' +
        '<div>Name</div>' +
        '<div>Type</div>' +
        '<div>Category</div>' +
        '<div>Status</div>' +
        '<div>Updated</div>' +
        '<div>Actions</div>' +
        '<div>Details</div>' +
      '</div>' +
      integrations.map((integration) => renderIntegrationRow(integration)).join('') +
    '</div>';

  el.configurationContent.querySelectorAll('[data-select-integration-id]').forEach((row) => {
      row.addEventListener('click', () => toggleConfigurationItem(row.getAttribute('data-select-integration-id')));
    });
    el.configurationContent.querySelectorAll('[data-expand-integration-id]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleConfigurationItem(button.getAttribute('data-expand-integration-id'));
      });
  });
  bindIntegrationActionHandlers(el.configurationContent);
}

function renderSystemSettingsView() {
  if (!el.configurationContent) return;
  const settings = getSystemSettingsRows();
  el.configurationContent.innerHTML =
    '<div class="configuration-panel">' +
      '<div class="configuration-panel-body">' +
        '<div class="configuration-title" style="font-size:18px">System Settings</div>' +
        '<div class="configuration-panel-note">System settings are currently read-only from the admin dashboard.</div>' +
        '<div class="config-grid" style="margin-top:16px">' + renderSettingRows(settings) + '</div>' +
      '</div>' +
    '</div>';
}

function renderComingSoonSection(section) {
  const sectionMeta = getConfigurationSectionMeta(section);
  const promptsNote = section === 'prompts'
    ? '<div class="configuration-panel-note">Prompts continue to use the dedicated top-level editor for now.</div>'
    : '';
  return (
    '<div class="configuration-panel">' +
      '<div class="configuration-panel-body">' +
        '<div class="configuration-title" style="font-size:18px">' + esc(sectionMeta.label) + '</div>' +
        '<div class="configuration-panel-note">This section is planned and ready for a dedicated implementation.</div>' +
        promptsNote +
      '</div>' +
    '</div>'
  );
}

function setConfigurationSection(section) {
  if (!section || section === S.configurationSection) return;
  const oldSection = S.configurationSection;
  S.configurationSection = section;
  S.configurationSearch = '';
  S.configurationFilters.status = 'all';
  const isCategorySection = ['tickets', 'code-review', 'agents'].includes(section);
  const wasCategory = ['tickets', 'code-review', 'agents'].includes(oldSection);
  if (isCategorySection && wasCategory) {
    // reset selection when switching between category sections as items are category-filtered
    S.selectedConfigurationItemId = null;
    S.configurationDrawerOpen = false;
  } else {
    S.configurationDrawerOpen = isCategorySection ? Boolean(getSelectedIntegration()) && S.configurationDrawerOpen : false;
  }
  S.configurationDrawerMode = 'view';
  renderConfiguration();
}

function selectConfigurationItem(id) {
  if (!id) return;
  S.selectedConfigurationItemId = id;
  S.configurationDrawerOpen = true;
  S.configurationDrawerMode = 'view';
  renderConfiguration();
}

function toggleConfigurationItem(id) {
  if (!id) return;
  if (S.selectedConfigurationItemId === id) {
    S.configurationDrawerOpen = !S.configurationDrawerOpen;
  } else {
    S.selectedConfigurationItemId = id;
    S.configurationDrawerOpen = true;
  }
  S.configurationDrawerMode = 'view';
  renderConfiguration();
}

function closeConfigurationDrawer() {
  S.configurationDrawerOpen = false;
  S.configurationDrawerMode = 'view';
  renderConfiguration();
}

function openConfigurationDrawerEdit() {
  S.configurationDrawerMode = 'edit';
  renderConfiguration();
}

function showEditIntegrationModal(id) {
  if (!id) return;
  S.selectedConfigurationItemId = id;
  S.configurationDrawerOpen = true;
  S.configurationDrawerMode = 'edit';
  renderConfiguration();
}

function closeConfigurationDrawerEdit() {
  S.configurationDrawerMode = 'view';
  renderConfiguration();
}

function getCategoryForSection(sectionId) {
  if (sectionId === 'tickets')     return 'ticketing';
  if (sectionId === 'code-review') return 'review';
  if (sectionId === 'agents')      return 'agent';
  return null;
}

function pluginSupportsCapability(plugin, capability) {
  if (!capability) return true;
  if (Array.isArray(plugin.capabilities) && plugin.capabilities.includes(capability)) return true;
  return plugin.category === capability;
}

function integrationSupportsCapability(integration, capability) {
  if (!capability) return true;
  if (Array.isArray(integration.capabilities) && integration.capabilities.includes(capability)) return true;
  return integration.category === capability;
}

function isConfigFieldVisible(fieldEl) {
  var dependencyWrapper = fieldEl.closest('[data-depends-on-field]');
  return !dependencyWrapper || dependencyWrapper.style.display !== 'none';
}

function collectConfigFields(root, options) {
  var config = {};
  var trimValues = !options || options.trimValues !== false;
  root.querySelectorAll('[data-field], [data-select-field]').forEach(function(fieldEl) {
    if (!isConfigFieldVisible(fieldEl)) return;
    var key = fieldEl.getAttribute('data-field') || fieldEl.getAttribute('data-select-field');
    if (!key) return;
    var isSecret = fieldEl.getAttribute('data-secret') === 'true';
    var rawValue = typeof fieldEl.value === 'string' ? fieldEl.value : '';
    var normalizedValue = trimValues ? rawValue.trim() : rawValue;
    if (isSecret && !rawValue.trim()) return;
    if (!isSecret && normalizedValue === '') return;
    config[key] = isSecret ? rawValue.trim() : normalizedValue;
  });
  return config;
}

function configurationSections() {
  return [
    { id: 'overview',       label: 'Overview',       meta: 'Summary',          description: 'High-level configuration posture across the admin surface.',                         comingSoon: false, category: undefined },
    { id: 'tickets',        label: 'Tickets',        meta: 'Ticket sources',   description: 'Manage ticket source integrations (Redmine, GitLab Issues).',                   comingSoon: false, category: 'ticketing' },
    { id: 'code-review',    label: 'Code Review',    meta: 'VCS connectors',   description: 'Manage version control and code review integrations (Gerrit, GitLab MR, GitHub PR).',     comingSoon: false, category: 'review' },
    { id: 'agents',         label: 'Agents',         meta: 'AI adapters',      description: 'Manage agent integrations (Copilot, Claude, Ollama).',                         comingSoon: false, category: 'agent' },
    { id: 'oauth-apps',        label: 'OAuth Apps',    meta: 'Provider registry', description: 'Map provider + base URL to OAuth client IDs for URL-based OAuth connect flows.',  comingSoon: false, category: undefined },
    { id: 'agents-library', label: 'Agents Library', meta: 'Reusable agents',  description: 'Reusable agent definitions (model + prompts) bound to projects.',              comingSoon: false, category: undefined },
    { id: 'projects',       label: 'Projects',       meta: 'Execution units',  description: 'Projects bind a ticket source + push targets to an agent.',                    comingSoon: false, category: undefined },
    { id: 'system-settings',label: 'System Settings',meta: 'Read-only',        description: 'Inspect runtime settings and polling intervals.',                                comingSoon: false, category: undefined },
    { id: 'prompts',        label: 'Prompts',        meta: 'System & custom',  description: 'Create, edit, and manage system and custom prompts.',                           comingSoon: false, category: undefined },
  ];
}

function getConfigurationSectionMeta(sectionId) {
  return configurationSections().find((section) => section.id === (sectionId || S.configurationSection)) || configurationSections()[0];
}

function getSystemSettingsRows() {
  if (!S.config) return [];
  return [
    ['Environment', S.config.nodeEnv],
    ['Log Level', S.config.logLevel],
    ['Max Cycles', String(S.config.maxAgentCycles)],
    ['Max Retries', String(S.config.maxRetryAttempts)],
    ['Polling Interval', S.config.pollingIntervalMs + 'ms'],
  ];
}

function renderSettingRows(rows) {
  if (!rows.length) {
    return '<div class="configuration-panel-note">No configuration data available.</div>';
  }
  return rows.map(([label, value]) =>
    '<div class="config-item"><span class="config-label">' + esc(label) + '</span><span class="config-value">' + esc(value) + '</span></div>'
  ).join('');
}

function getFilteredIntegrations() {
  const query = S.configurationSearch.trim().toLowerCase();
  const sectionCategory = getCategoryForSection(S.configurationSection);
  return S.integrations.filter((integration) => {
    if (sectionCategory !== null && integration.category !== sectionCategory) return false;
    const matchesQuery = !query || [integration.name, integration.type, integration.category || '']
      .join(' ')
      .toLowerCase()
      .includes(query);
    if (!matchesQuery) return false;
    const filter = S.configurationFilters.status;
    if (filter === 'active') return Boolean(integration.active);
    if (filter === 'enabled') return Boolean(integration.enabled);
    if (filter === 'disabled') return !integration.enabled;
    return true;
  });
}

function renderIntegrationRow(integration) {
  const isSelected = integration.id === S.selectedConfigurationItemId;
  const isExpanded = isSelected && S.configurationDrawerOpen;
  const selected = isSelected ? ' is-selected' : '';
  const expanded = isExpanded ? ' is-expanded' : '';
  return (
    '<div class="integration-row-wrap">' +
      '<div class="integration-row' + selected + expanded + '" data-select-integration-id="' + esc(integration.id) + '">' +
        '<div class="integration-primary">' +
          '<div class="integration-name">' + esc(integration.name) + '</div>' +
          '<div class="integration-subtitle">ID ' + esc(integration.id) + '</div>' +
        '</div>' +
        '<div class="integration-cell">' + esc(integration.type) + '</div>' +
        '<div class="integration-cell muted">' + esc(integration.category || 'unknown') + '</div>' +
        '<div class="integration-cell"><span class="badge" data-tone="' + integrationTone(integration) + '">' + esc(integrationStatusLabel(integration)) + '</span></div>' +
        '<div class="integration-cell muted">' + esc(fmt(integration.updatedAt)) + '</div>' +
        '<div class="integration-quick-actions">' +
          '<button class="toggle' + (integration.enabled ? ' on' : '') + '" data-toggle-id="' + esc(integration.id) + '" title="' + (integration.enabled ? 'Disable' : 'Enable') + '"></button>' +
          '<button class="icon-btn" data-edit-id="' + esc(integration.id) + '" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
          '<button class="icon-btn" data-test-id="' + esc(integration.id) + '" title="Test connection"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></button>' +
          '<button class="icon-btn danger" data-delete-id="' + esc(integration.id) + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>' +
        '</div>' +
        '<div class="integration-cell">' +
          '<button class="integration-row-expand" data-expand-integration-id="' + esc(integration.id) + '">' +
            '<span class="integration-row-chevron">' + (isExpanded ? '▲' : '▼') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      (isExpanded ? renderExpandedIntegrationDetails(integration) : '') +
    '</div>'
  );
}

function renderExpandedIntegrationDetails(selected) {
  const statusTone = integrationTone(selected);
  const statusLabel = integrationStatusLabel(selected);
  const streamEventsSupported = selected.streamEventsSupported === true;
  const streamStatus = streamEventsSupported ? (selected.streamStatus || null) : null;
  const streamPanel = streamStatus
    ? (
      '<div class="integration-row-details-panel integration-row-details-wide">' +
        '<div class="integration-row-details-title"><strong>Stream Events</strong></div>' +
        renderSettingRows([
          ['State', String(streamStatus.state || 'unknown')],
          ['Last event', String(streamStatus.lastEventType || '—')],
          ['Last event at', streamStatus.lastEventAt ? fmt(streamStatus.lastEventAt) : '—'],
          ['Reconnects', String(streamStatus.reconnectCount || 0)],
          ['Last error', String(streamStatus.lastError || '—')],
        ]) +
      '</div>'
    )
    : (streamEventsSupported
      ? (
        '<div class="integration-row-details-panel integration-row-details-wide">' +
          '<div class="integration-row-details-title"><strong>Stream Events</strong></div>' +
          '<div class="configuration-panel-note">No live stream state available for this integration.</div>' +
        '</div>'
      )
      : '');
  const webhookSecurityPanel = selected.type === 'gerrit'
    ? ''
    : (
      '<div class="integration-row-details-panel integration-row-details-wide">' +
        '<div class="integration-row-details-title"><strong>Webhook Security</strong></div>' +
        '<div data-role="webhook-allowed-ips-view" style="display:flex;flex-direction:column;gap:12px;">' +
          '<div style="font-size:12px;color:var(--muted);">Allowed IPs for webhook signature bypass (useful for private networks without auth header support)</div>' +
          '<div data-role="webhook-ips-list" style="border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg);min-height:60px;"></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<input data-role="webhook-ip-input" type="text" placeholder="e.g., 192.168.48.60" style="flex:1;min-width:150px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;" />' +
            '<button data-role="webhook-ip-add" style="padding:6px 12px;border:1px solid var(--border);border-radius:4px;background:var(--accent);color:white;cursor:pointer;font-size:12px;font-weight:600;">Add IP</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

  if (S.configurationDrawerMode === 'edit') {
    if (S.plugins.length === 0) {
      loadPlugins().then(() => renderConfiguration());
      return '<div class="integration-row-details" data-integration-details-for="' + esc(selected.id) + '"><div class="configuration-panel-note">Loading fields…</div></div>';
    }

    const plugin = S.plugins.find((p) => p.type === selected.type);
    const fieldsHtml = plugin
      ? plugin.requiredFields.filter((f) => !f.hidden).map((f) => {
          if (f.type === 'submodule-list') {
            const existingSubmodules = (selected.config && Array.isArray(selected.config[f.key])) ? selected.config[f.key] : [];
            return renderSubmoduleListField(existingSubmodules);
          }
          let fieldHtml;
          if (f.type === 'select' && f.options) {
            // For gerritMode: derive from existing config if not explicitly stored
            const currentSelectValue =
              (f.key === 'gerritMode' && selected.type === 'gerrit')
                ? (selected.config?.reviewerAccountId ? 'review' : 'code')
                : String(selected.config?.[f.key] ?? f.options[0]?.value ?? '');
            fieldHtml =
              '<label>' + esc(f.label) + (f.required ? ' *' : '') + '</label>' +
              '<select data-select-field="' + esc(f.key) + '">' +
                f.options.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === currentSelectValue ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
              '</select>';
          } else {
            const isSecret = f.type === 'password';
            const currentValue = selected.config && !isSecret ? String(selected.config[f.key] ?? '') : '';
            fieldHtml = (
              '<label>' + esc(f.label) + (f.required ? ' *' : '') + '</label>' +
              '<input ' +
                'data-field="' + esc(f.key) + '" ' +
                'data-secret="' + String(isSecret) + '" ' +
                'type="' + (isSecret ? 'password' : f.type === 'number' ? 'number' : 'text') + '" ' +
                (isSecret ? 'placeholder="********" ' : 'value="' + esc(currentValue) + '" ') +
              '/>'
            );
          }
          if (f.dependsOn) {
            // Determine initial visibility based on the controlling field's current value
            const controllerValue =
              (f.dependsOn.field === 'gerritMode' && selected.type === 'gerrit')
                ? (selected.config?.reviewerAccountId ? 'review' : 'code')
                : String(selected.config?.[f.dependsOn.field] ?? '');
            const isVisible = controllerValue === f.dependsOn.value;
            return (
              '<div data-depends-on-field="' + esc(f.dependsOn.field) + '" data-depends-on-value="' + esc(f.dependsOn.value) + '"' +
                (isVisible ? '' : ' style="display:none"') +
              '>' + fieldHtml + '</div>'
            );
          }
          return '<div>' + fieldHtml + '</div>';
        }).join('')
      : '<div class="configuration-panel-note">Unknown integration type: ' + esc(selected.type) + '</div>';

    return (
      '<div class="integration-row-details" data-integration-details-for="' + esc(selected.id) + '">' +
        '<div class="integration-row-details-grid">' +
          '<div class="integration-row-details-panel integration-row-details-wide">' +
            '<div class="integration-row-details-title">' +
              '<strong>Editing ' + esc(selected.name) + '</strong>' +
              '<span class="badge" data-tone="' + statusTone + '">' + esc(statusLabel) + '</span>' +
            '</div>' +
            '<div class="integration-row-edit-form" data-role="drawer-edit-form">' +
              '<div>' +
                '<label>Name *</label>' +
                '<input data-role="drawer-edit-name" type="text" value="' + esc(selected.name || '') + '" />' +
              '</div>' +
              fieldsHtml +
            '</div>' +
            '<div class="integration-row-details-actions">' +
              '<button class="primary" data-role="drawer-edit-save">Save</button>' +
              '<button data-role="drawer-edit-test">Test Connection</button>' +
              '<button data-role="inline-cancel-edit">Cancel</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  const configRows = Object.entries(selected.config || {}).map(([key, value]) => {
    if (key === 'submodules' && Array.isArray(value)) {
      return '<div class="config-item"><span class="config-label">' + esc(key) + '</span><span class="config-value">' + value.length + ' submodule(s) configured</span></div>';
    }
    return '<div class="config-item"><span class="config-label">' + esc(key) + '</span><span class="config-value">' + esc(String(value)) + '</span></div>';
  }).join('') || '<div class="configuration-panel-note">No stored values available.</div>';

  return (
    '<div class="integration-row-details" data-integration-details-for="' + esc(selected.id) + '">' +
      '<div class="integration-row-details-grid">' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title">' +
            '<strong>Summary</strong>' +
            '<span class="badge" data-tone="' + statusTone + '">' + esc(statusLabel) + '</span>' +
          '</div>' + renderSettingRows([
            ['Type', selected.type],
            ['Category', selected.category || 'unknown'],
            ['Last updated', fmt(selected.updatedAt)],
            ['Created', fmt(selected.createdAt)],
          ]) +
        '</div>' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title"><strong>Masked configuration</strong></div>' + configRows +
        '</div>' +
        '<div class="integration-row-details-panel integration-row-details-wide">' +
          '<div class="integration-row-details-title"><strong>Actions</strong></div>' +
          '<div class="integration-row-details-actions">' +
            '<button data-role="inline-toggle">' + esc(selected.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="primary" data-role="inline-edit">Edit Integration</button>' +
            '<button data-role="inline-test">Test Connection</button>' +
            '<button class="danger" data-role="inline-delete">Delete</button>' +
          '</div>' +
        '</div>' +
        streamPanel +
        webhookSecurityPanel +
      '</div>' +
    '</div>'
  );
}

function bindIntegrationActionHandlers(root) {
  root.querySelectorAll('[data-toggle-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleIntegration(btn.getAttribute('data-toggle-id'));
    });
  });
  root.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      showEditIntegrationModal(btn.getAttribute('data-edit-id'));
    });
  });
  root.querySelectorAll('[data-test-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void testIntegration(btn.getAttribute('data-test-id'));
    });
  });
  root.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteIntegration(btn.getAttribute('data-delete-id'));
    });
  });
  root.querySelectorAll('[data-role="inline-toggle"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      if (selected) void toggleIntegration(selected.id);
    });
  });
  root.querySelectorAll('[data-role="inline-edit"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openConfigurationDrawerEdit();
    });
  });
  root.querySelectorAll('[data-role="inline-test"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      if (selected) void testIntegration(selected.id);
    });
  });
  root.querySelectorAll('[data-role="inline-delete"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      if (selected) void deleteIntegration(selected.id);
    });
  });
  root.querySelectorAll('[data-role="inline-cancel-edit"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeConfigurationDrawerEdit();
    });
  });
  root.querySelectorAll('[data-role="drawer-edit-save"]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      const editRoot = selected ? getExpandedIntegrationRoot(selected.id) : null;
      if (!selected || !editRoot) return;
      const nameInput = editRoot.querySelector('[data-role="drawer-edit-name"]');
      const name = nameInput?.value?.trim() || selected.name;
      const config = collectConfigFields(editRoot, { trimValues: false });
      var submoduleContainer = editRoot.querySelector('[data-role="submodule-list"]');
      if (submoduleContainer) {
        var submodules = collectSubmoduleConfigs(submoduleContainer);
        if (submodules.length > 0) config.submodules = submodules;
      }
      try {
        const result = await adminFetch('/api/admin/integrations/' + enc(selected.id), 'PUT', JSON.stringify({ name, config }));
        const message = result.appliedAtRuntime ? 'Configuration applied at runtime' : 'Integration updated';
        showActionToast(message, false);
        closeConfigurationDrawerEdit();
        await loadProviders();
        await loadIntegrations();
      } catch (err) {
        showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
      }
    });
  });
  root.querySelectorAll('[data-role="drawer-edit-test"]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      const editRoot = selected ? getExpandedIntegrationRoot(selected.id) : null;
      if (!selected || !editRoot) return;
      btn.disabled = true;
      btn.textContent = 'Testing…';
      const config = collectConfigFields(editRoot);
      var submoduleContainer = editRoot.querySelector('[data-role="submodule-list"]');
      if (submoduleContainer) {
        var submodules = collectSubmoduleConfigs(submoduleContainer);
        if (submodules.length > 0) config.submodules = submodules;
      }
      try {
        const r = await adminFetch('/api/admin/integrations/test', 'POST', JSON.stringify({ integrationId: selected.id, type: selected.type, config }));
        if (r.success) {
          showActionToast('Connection OK', false);
        } else if (r.error) {
          showDetailedError('Connection Failed', r.error);
        } else {
          showDetailedError('Connection Failed', 'Unknown error');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showDetailedError('Test Error', msg);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test Connection';
      }
    });
  });
  root.querySelectorAll('[data-role="webhook-ip-add"]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const selected = getSelectedIntegration();
      if (!selected) return;
      const container = btn.closest('[data-role="webhook-allowed-ips-view"]');
      if (!container) return;
      const input = container.querySelector('[data-role="webhook-ip-input"]');
      if (!input) return;
      const newIp = input.value.trim();
      if (!newIp) {
        showActionToast('Please enter an IP address', true);
        return;
      }
      const ips = await loadWebhookAllowedIps(selected.id);
      if (ips.includes(newIp)) {
        showActionToast('This IP is already in the list', true);
        return;
      }
      const newIps = [...ips, newIp];
      if (await saveWebhookAllowedIps(selected.id, newIps)) {
        input.value = '';
        await loadAndRenderWebhookIps(selected.id);
      }
    });
  });
  root.querySelectorAll('[data-integration-details-for]').forEach((detailDiv) => {
    const match = detailDiv.getAttribute('data-integration-details-for');
    if (match) {
      void loadAndRenderWebhookIps(match);
    }
  });
  bindSubmoduleListHandlers(root);
  // Provider descriptors may declare an OAuth flow for integration auth.
  const editForm = root.querySelector('[data-role="drawer-edit-form"]');
  const selectedForOAuth = getSelectedIntegration();
  const pluginForOAuth = selectedForOAuth
    ? S.plugins.find((plugin) => plugin.type === selectedForOAuth.type)
    : null;
  if (editForm && pluginForOAuth?.oauth) {
    initOAuthButton(editForm, pluginForOAuth.oauth, {
      hasExistingToken: !!(selectedForOAuth?.config?.[pluginForOAuth.oauth.tokenField]),
      integrationId: selectedForOAuth?.id || null,
    });
  }
  bindDependsOnHandlers(root);
}

function getSelectedIntegration() {
  return S.integrations.find((integration) => integration.id === S.selectedConfigurationItemId) || null;
}

function syncSelectedConfigurationItem() {
  if (!S.selectedConfigurationItemId) return;
  const selected = getSelectedIntegration();
  if (!selected) {
    S.selectedConfigurationItemId = null;
    S.configurationDrawerOpen = false;
  }
}

function integrationTone(integration) {
  if (!integration.enabled) return 'neutral';
  return integration.active ? 'ok' : 'warn';
}

function integrationStatusLabel(integration) {
  if (!integration.enabled) return 'disabled';
  return integration.active ? 'active' : 'enabled';
}

function getExpandedIntegrationRoot(id) {
  if (!el.configurationContent || !id) return null;
  return el.configurationContent.querySelector('[data-integration-details-for="' + CSS.escape(id) + '"]');
}

function filterOption(value, label) {
  return '<option value="' + esc(value) + '"' + (S.configurationFilters.status === value ? ' selected' : '') + '>' + esc(label) + '</option>';
}

function summaryCard(label, value) {
  return (
    '<div class="configuration-summary-card">' +
      '<div class="configuration-summary-label">' + esc(label) + '</div>' +
      '<div class="configuration-summary-value">' + esc(value) + '</div>' +
    '</div>'
  );
}

async function toggleIntegration(id) {
  const i = S.integrations.find((x) => x.id === id);
  if (!i) return;
  const action = i.enabled ? 'disable' : 'enable';
  try {
    await adminFetch('/api/admin/integrations/' + enc(id) + '/' + action, 'PATCH');
    showActionToast(i.name + ' ' + (i.enabled ? 'disabled' : 'enabled'), false);
    await loadProviders();
    await loadIntegrations();
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function testIntegration(id) {
  try {
    const r = await adminFetch('/api/admin/integrations/' + enc(id) + '/test', 'POST');
    if (r.success) {
      showActionToast('Connection OK', false);
    } else if (r.error) {
      showDetailedError('Connection Failed', r.error);
    } else {
      showActionToast('Connection failed', true);
    }
  } catch (err) {
    showActionToast('Test error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

function renderSubmoduleListField(existingSubmodules) {
  const rows = Array.isArray(existingSubmodules)
    ? existingSubmodules.map((sub, i) => renderSubmoduleRow(sub, i)).join('')
    : '';
  return (
    '<div data-role="submodule-list" style="margin-top:12px;">' +
      '<label>Submodules</label>' +
      '<p style="font-size:11px;color:var(--muted);margin:2px 0 8px;">Leave SSH fields empty to inherit from parent Gerrit config.</p>' +
      '<div data-role="submodule-rows">' + rows + '</div>' +
      '<button type="button" data-role="add-submodule" style="margin-top:4px;font-size:12px;">+ Add Submodule</button>' +
    '</div>'
  );
}

function renderSubmoduleRow(sub, idx) {
  sub = sub || {};
  const g = sub.gerrit || {};
  return (
    '<div data-role="submodule-row" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;position:relative;">' +
      '<button type="button" data-role="remove-submodule" style="position:absolute;top:4px;right:6px;background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;" title="Remove">&times;</button>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
        '<div><label style="font-size:11px;">Path *</label><input data-subfield="path" type="text" value="' + esc(String(sub.path || '')) + '" placeholder="libs/daemon" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">Repo Clone URL *</label><input data-subfield="repoCloneUrl" type="text" value="' + esc(String(g.repoCloneUrl || '')) + '" placeholder="ssh://ve@gerrit:29418/project" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">Base URL *</label><input data-subfield="baseUrl" type="text" value="' + esc(String(g.baseUrl || '')) + '" placeholder="https://gerrit.example.com" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">Target Branch *</label><input data-subfield="targetBranch" type="text" value="' + esc(String(g.targetBranch || '')) + '" placeholder="master" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">SSH Host</label><input data-subfield="sshHost" type="text" value="' + esc(String(g.sshHost || '')) + '" placeholder="(inherit)" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">SSH Port</label><input data-subfield="sshPort" type="number" value="' + esc(String(g.sshPort || '')) + '" placeholder="(inherit)" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">SSH User</label><input data-subfield="sshUser" type="text" value="' + esc(String(g.sshUser || '')) + '" placeholder="(inherit)" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">Git Author Name</label><input data-subfield="gitAuthorName" type="text" value="' + esc(String(g.gitAuthorName || '')) + '" placeholder="(inherit)" style="width:100%;" /></div>' +
        '<div><label style="font-size:11px;">Git Author Email</label><input data-subfield="gitAuthorEmail" type="text" value="' + esc(String(g.gitAuthorEmail || '')) + '" placeholder="(inherit)" style="width:100%;" /></div>' +
      '</div>' +
    '</div>'
  );
}

function collectSubmoduleConfigs(container) {
  var rows = container.querySelectorAll('[data-role="submodule-row"]');
  var submodules = [];
  rows.forEach(function(row) {
    var sub = { reviewSystem: 'gerrit', gerrit: {} };
    sub.path = (row.querySelector('[data-subfield="path"]')?.value || '').trim();
    sub.gerrit.repoCloneUrl = (row.querySelector('[data-subfield="repoCloneUrl"]')?.value || '').trim();
    sub.gerrit.baseUrl = (row.querySelector('[data-subfield="baseUrl"]')?.value || '').trim();
    sub.gerrit.targetBranch = (row.querySelector('[data-subfield="targetBranch"]')?.value || '').trim();
    var sshHost = (row.querySelector('[data-subfield="sshHost"]')?.value || '').trim();
    if (sshHost) sub.gerrit.sshHost = sshHost;
    var sshPort = (row.querySelector('[data-subfield="sshPort"]')?.value || '').trim();
    if (sshPort) sub.gerrit.sshPort = parseInt(sshPort, 10);
    var sshUser = (row.querySelector('[data-subfield="sshUser"]')?.value || '').trim();
    if (sshUser) sub.gerrit.sshUser = sshUser;
    var gitAuthorName = (row.querySelector('[data-subfield="gitAuthorName"]')?.value || '').trim();
    if (gitAuthorName) sub.gerrit.gitAuthorName = gitAuthorName;
    var gitAuthorEmail = (row.querySelector('[data-subfield="gitAuthorEmail"]')?.value || '').trim();
    if (gitAuthorEmail) sub.gerrit.gitAuthorEmail = gitAuthorEmail;
    if (sub.path && sub.gerrit.baseUrl && sub.gerrit.targetBranch) {
      submodules.push(sub);
    }
  });
  return submodules;
}

/**
 * Wire up [data-select-field] elements so that sibling/child elements
 * annotated with data-depends-on-field / data-depends-on-value are shown
 * only when the controlling select has the expected value.
 */
function bindDependsOnHandlers(root) {
  root.querySelectorAll('[data-select-field]').forEach(function(selectEl) {
    var fieldName = selectEl.getAttribute('data-select-field');
    if (!fieldName) return;
    function applyVisibility() {
      var currentValue = selectEl.value;
      var searchRoot = selectEl.closest('[data-role="modal-fields"], [data-role="drawer-edit-form"]') || root;
      searchRoot.querySelectorAll('[data-depends-on-field="' + fieldName + '"]').forEach(function(dep) {
        var requiredValue = dep.getAttribute('data-depends-on-value');
        dep.style.display = (currentValue === requiredValue) ? '' : 'none';
      });
    }
    selectEl.addEventListener('change', applyVisibility);
    applyVisibility();
  });
}

function bindSubmoduleListHandlers(root) {
  root.querySelectorAll('[data-role="add-submodule"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var container = btn.closest('[data-role="submodule-list"]');
      if (!container) return;
      var rowsDiv = container.querySelector('[data-role="submodule-rows"]');
      if (!rowsDiv) return;
      var temp = document.createElement('div');
      temp.innerHTML = renderSubmoduleRow({}, 0);
      var newRow = temp.firstElementChild;
      rowsDiv.appendChild(newRow);
      if (newRow) {
        newRow.querySelector('[data-role="remove-submodule"]')?.addEventListener('click', function() {
          newRow.remove();
        });
      }
    });
  });
  root.querySelectorAll('[data-role="remove-submodule"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var row = btn.closest('[data-role="submodule-row"]');
      if (row) row.remove();
    });
  });
}

async function deleteIntegration(id) {
  if (!confirm('Delete this integration?')) return;
  try {
    await adminFetch('/api/admin/integrations/' + enc(id), 'DELETE');
    showActionToast('Integration deleted', false);
    await loadProviders();
    await loadIntegrations();
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function loadWebhookAllowedIps(integrationId) {
  try {
    const r = await adminFetch('/api/admin/integrations/' + enc(integrationId) + '/webhook-allowed-ips', 'GET');
    return Array.isArray(r.allowedIps) ? r.allowedIps : [];
  } catch (err) {
    console.error('Failed to load allowed IPs:', err);
    return [];
  }
}

async function saveWebhookAllowedIps(integrationId, ips) {
  try {
    await adminFetch('/api/admin/integrations/' + enc(integrationId) + '/webhook-allowed-ips', 'PUT', JSON.stringify({ allowedIps: ips }));
    showActionToast('Allowed IPs updated', false);
    return true;
  } catch (err) {
    showActionToast('Error saving IPs: ' + (err instanceof Error ? err.message : 'Unknown'), true);
    return false;
  }
}

function renderWebhookIpsList(ips) {
  if (!ips || ips.length === 0) {
    return '<div style="color:var(--muted);font-size:12px;font-style:italic;">No IPs allowed. Add one to skip signature verification for that IP.</div>';
  }
  return ips.map((ip, idx) => {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px;background:var(--surface);border-radius:4px;border:1px solid var(--border);margin-bottom:4px;">' +
      '<span style="font-family:monospace;font-size:12px;">' + esc(ip) + '</span>' +
      '<button data-role="remove-webhook-ip" data-ip="' + esc(ip) + '" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;padding:2px 4px;">✕</button>' +
      '</div>';
  }).join('');
}

async function loadAndRenderWebhookIps(integrationId) {
  const ips = await loadWebhookAllowedIps(integrationId);
  const listDiv = document.querySelector('[data-integration-details-for="' + CSS.escape(integrationId) + '"] [data-role="webhook-ips-list"]');
  if (listDiv) {
    listDiv.innerHTML = renderWebhookIpsList(ips);
    listDiv.querySelectorAll('[data-role="remove-webhook-ip"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ipToRemove = btn.getAttribute('data-ip');
        const newIps = ips.filter((ip) => ip !== ipToRemove);
        if (await saveWebhookAllowedIps(integrationId, newIps)) {
          await loadAndRenderWebhookIps(integrationId);
        }
      });
    });
  }
}

function initOAuthButton(container, oauth, opts) {
  if (oauth.mode === 'redirect') return initRedirectOAuthButton(container, oauth, opts);
  return initDeviceOAuthButton(container, oauth, opts);
}

function renderOAuthPlaintextWarning() {
  return (
    '<div style="margin-top:8px;padding:8px 10px;border-radius:4px;background:#fff3cd;color:#856404;font-size:12px;border:1px solid #ffc107;">' +
      '\u26a0\ufe0f <strong>No ADMIN_AUTH_SECRET set</strong> \u2014 the token is stored unencrypted.' +
      ' Set <code>ADMIN_AUTH_SECRET</code> in production to encrypt tokens at rest.' +
    '</div>'
  );
}

function generateOAuthState() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

function generatePKCECodeVerifier() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(64);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function(byte) {
      return alphabet[byte % alphabet.length];
    }).join('');
  }
  return generateOAuthState() + generateOAuthState();
}

async function buildPKCECodeChallenge(codeVerifier) {
  if (!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function')) {
    throw new Error('Browser does not support OAuth PKCE');
  }

  const encodedVerifier = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', encodedVerifier);
  const digestBytes = new Uint8Array(digest);
  let binary = '';
  digestBytes.forEach(function(byte) {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}

async function resolveGitLabOAuthConfig(container, config) {
  const providerSection = container.querySelector('[data-oauth-provider="GitLab"]');
  if (!providerSection || !config || config.authMode !== 'oauth') {
    return config;
  }

  if (typeof config.oauthClientId === 'string' && config.oauthClientId.trim()) {
    return config;
  }

  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (!baseUrl) {
    throw new Error('GitLab Base URL is required before connecting.');
  }

  const response = await adminFetch('/api/admin/oauth-apps/resolve', 'POST', JSON.stringify({ provider: 'gitlab', baseUrl }));
  const app = response && response.app ? response.app : null;
  if (!app || typeof app.clientId !== 'string') {
    throw new Error('No OAuth app is configured for ' + baseUrl + '. Ask an administrator to add one in Configuration / OAuth Apps.');
  }

  return {
    ...config,
    baseUrl: typeof app.baseUrl === 'string' ? app.baseUrl : baseUrl,
    oauthClientId: app.clientId,
  };
}

function initRedirectOAuthButton(container, oauth, opts) {
  const hasExistingToken = !!(opts && opts.hasExistingToken);

  const sectionWrapper = document.createElement('div');
  sectionWrapper.setAttribute('data-oauth-provider', oauth.providerName);
  if (oauth.dependsOn) {
    sectionWrapper.setAttribute('data-depends-on-field', oauth.dependsOn.field);
    sectionWrapper.setAttribute('data-depends-on-value', oauth.dependsOn.value);
    sectionWrapper.style.display = 'none';
  }

  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'hidden';
  hiddenInput.setAttribute('data-field', oauth.tokenField);
  hiddenInput.setAttribute('data-secret', 'true');
  sectionWrapper.appendChild(hiddenInput);

  const section = document.createElement('div');
  section.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-top:8px;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px;';
  heading.textContent = oauth.heading;
  section.appendChild(heading);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';

  const oauthBtn = document.createElement('button');
  oauthBtn.type = 'button';
  oauthBtn.textContent = hasExistingToken ? oauth.reconnectLabel : oauth.connectLabel;
  oauthBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:7px 14px;font-size:13px;font-weight:500;border:1px solid var(--border);border-radius:5px;background:var(--accent);color:#fff;cursor:pointer;';
  btnRow.appendChild(oauthBtn);

  if (hasExistingToken) {
    const badge = document.createElement('span');
    badge.textContent = '\u2713 Connected';
    badge.style.cssText = 'font-size:12px;color:var(--success,#4caf50);';
    btnRow.appendChild(badge);
  }

  section.appendChild(btnRow);

  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'margin-top:10px;font-size:12px;';
  section.appendChild(statusDiv);

  sectionWrapper.appendChild(section);
  container.appendChild(sectionWrapper);

  oauthBtn.addEventListener('click', async () => {
    oauthBtn.disabled = true;
    oauthBtn.textContent = 'Starting\u2026';
    statusDiv.textContent = '';
    try {
      const redirectUri = window.location.origin + window.location.pathname;
      const oauthState = generateOAuthState();
      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await buildPKCECodeChallenge(codeVerifier);
      const config = collectConfigFields(container, { trimValues: false });
      const resolvedConfig = await resolveGitLabOAuthConfig(container, config);
      const startRes = await adminFetch(oauth.startPath, 'POST', JSON.stringify({
        redirectUri,
        state: oauthState,
        codeChallenge,
        codeChallengeMethod: 'S256',
        config: resolvedConfig,
        integrationId: opts && opts.integrationId ? opts.integrationId : undefined,
      }));
      if (!startRes || typeof startRes.authorizationUrl !== 'string' || !startRes.authorizationUrl) {
        throw new Error('Missing authorizationUrl');
      }

      const popup = window.open(startRes.authorizationUrl, '_blank', 'popup,width=960,height=720');
      if (!popup) {
        throw new Error('Popup blocked');
      }

      oauthBtn.textContent = oauth.pendingLabel;
      statusDiv.textContent = 'Complete the authentication in the popup window.';

      let completed = false;
      const pollTimer = window.setInterval(async () => {
        if (completed) return;
        if (popup.closed) {
          window.clearInterval(pollTimer);
          oauthBtn.disabled = false;
          oauthBtn.textContent = hiddenInput.value ? oauth.reconnectLabel : oauth.connectLabel;
          if (!hiddenInput.value) {
            statusDiv.textContent = 'Authentication window closed before completion.';
          }
          return;
        }

        let popupUrl;
        try {
          popupUrl = popup.location.href;
        } catch {
          return;
        }

        if (!popupUrl || popup.location.origin !== window.location.origin) {
          return;
        }

        const callbackUrl = new URL(popupUrl);
        const error = callbackUrl.searchParams.get('error');
        const errorDescription = callbackUrl.searchParams.get('error_description');
        const code = callbackUrl.searchParams.get('code');
        const state = callbackUrl.searchParams.get('state');
        if (!error && !code) {
          return;
        }

        completed = true;
        window.clearInterval(pollTimer);

        try {
          if (error) {
            throw new Error(errorDescription || error);
          }
          if (state !== oauthState) {
            throw new Error('OAuth state mismatch');
          }
          const latestConfig = collectConfigFields(container, { trimValues: false });
          const latestResolvedConfig = await resolveGitLabOAuthConfig(container, latestConfig);
          const tokenRes = await adminFetch(oauth.completePath, 'POST', JSON.stringify({
            code,
            state,
            redirectUri,
            codeVerifier,
            config: latestResolvedConfig,
            integrationId: opts && opts.integrationId ? opts.integrationId : undefined,
          }));
          hiddenInput.value = tokenRes.encryptedToken;
          let successHtml = '<span style="color:var(--success,#4caf50);font-size:13px;">&#10003; Connected \u2014 save the integration to persist.</span>';
          if (tokenRes.isPlaintext) {
            successHtml += renderOAuthPlaintextWarning();
          }
          statusDiv.innerHTML = successHtml;
          oauthBtn.textContent = oauth.reconnectLabel;
          popup.close();
        } catch (completeErr) {
          statusDiv.textContent = 'Auth failed: ' + (completeErr instanceof Error ? completeErr.message : String(completeErr));
          oauthBtn.textContent = hiddenInput.value ? oauth.reconnectLabel : oauth.connectLabel;
        } finally {
          oauthBtn.disabled = false;
        }
      }, 500);
    } catch (err) {
      statusDiv.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
      oauthBtn.textContent = hiddenInput.value ? oauth.reconnectLabel : oauth.connectLabel;
      oauthBtn.disabled = false;
    }
  });
}

/**
 * Inject a self-contained OAuth device-flow section into a container element.
 * The descriptor supplies the field key, labels, and endpoints so the
 * dashboard does not branch on provider types.
 */
function initDeviceOAuthButton(container, oauth, opts) {
  const hasExistingToken = !!(opts && opts.hasExistingToken);

  const sectionWrapper = document.createElement('div');
  if (oauth.dependsOn) {
    sectionWrapper.setAttribute('data-depends-on-field', oauth.dependsOn.field);
    sectionWrapper.setAttribute('data-depends-on-value', oauth.dependsOn.value);
    sectionWrapper.style.display = 'none';
  }

  // Hidden input — collected by the save handler via [data-field].
  // When empty it is skipped automatically, so an existing token is
  // preserved unless the user completes a fresh OAuth flow.
  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'hidden';
  hiddenInput.setAttribute('data-field', oauth.tokenField);
  hiddenInput.setAttribute('data-secret', 'true');
  sectionWrapper.appendChild(hiddenInput);

  // Section wrapper
  const section = document.createElement('div');
  section.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-top:8px;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px;';
  heading.textContent = oauth.heading;
  section.appendChild(heading);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';

  const oauthBtn = document.createElement('button');
  oauthBtn.type = 'button';
  oauthBtn.textContent = hasExistingToken ? oauth.reconnectLabel : oauth.connectLabel;
  oauthBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:7px 14px;font-size:13px;font-weight:500;border:1px solid var(--border);border-radius:5px;background:var(--accent);color:#fff;cursor:pointer;';
  btnRow.appendChild(oauthBtn);

  if (hasExistingToken) {
    const badge = document.createElement('span');
    badge.textContent = '\u2713 Connected';
    badge.style.cssText = 'font-size:12px;color:var(--success,#4caf50);';
    btnRow.appendChild(badge);
  }

  section.appendChild(btnRow);

  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'margin-top:10px;font-size:12px;';
  section.appendChild(statusDiv);

  sectionWrapper.appendChild(section);
  container.appendChild(sectionWrapper);

  oauthBtn.addEventListener('click', async () => {
    oauthBtn.disabled = true;
    oauthBtn.textContent = 'Starting\u2026';
    statusDiv.innerHTML = '';
    try {
      const config = collectConfigFields(container, { trimValues: false });
      const startRes = await adminFetch(oauth.startPath, 'POST', JSON.stringify({
        config,
        integrationId: opts && opts.integrationId ? opts.integrationId : undefined,
      }));
      const userCode = startRes.userCode;
      const verificationUri = startRes.verificationUri;
      const deviceCode = startRes.deviceCode;
      const expiresIn = startRes.expiresIn || 300;

      // Render a prominent device-code panel
      statusDiv.innerHTML =
        '<div style="border:1px solid var(--border);border-radius:5px;padding:12px 14px;background:var(--surface2,var(--surface));">' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">1. Open the link below and enter the code:</div>' +
          '<a href="' + verificationUri + '" target="_blank" rel="noopener"' +
          '   style="display:inline-block;padding:6px 12px;border-radius:4px;background:var(--accent);color:#fff;text-decoration:none;font-size:12px;font-weight:500;margin-bottom:10px;">' +
          '  Open ' + esc(oauth.providerName) + ' &rarr;' +
          '</a>' +
          '<div style="font-size:22px;letter-spacing:6px;font-weight:700;font-family:monospace;margin-bottom:8px;">' + userCode + '</div>' +
          '<div style="font-size:11px;color:var(--muted);"><span data-role="oauth-countdown"></span></div>' +
        '</div>';

      oauthBtn.textContent = oauth.pendingLabel;

      // Countdown timer
      let remaining = expiresIn;
      const countdownEl = statusDiv.querySelector('[data-role="oauth-countdown"]');
      const ticker = setInterval(() => {
        remaining--;
        if (countdownEl) countdownEl.textContent = 'Expires in ' + remaining + 's';
        if (remaining <= 0) clearInterval(ticker);
      }, 1000);

      // Await the token (server polls the provider until authorized or expired)
      try {
        const tokenRes = await adminFetch(oauth.completePath, 'POST', JSON.stringify({
          deviceCode,
          config,
          integrationId: opts && opts.integrationId ? opts.integrationId : undefined,
        }));
        clearInterval(ticker);
        hiddenInput.value = tokenRes.encryptedToken;
        let successHtml = '<span style="color:var(--success,#4caf50);font-size:13px;">&#10003; Connected \u2014 save the integration to persist.</span>';
        if (tokenRes.isPlaintext) {
          successHtml += renderOAuthPlaintextWarning();
        }
        statusDiv.innerHTML = successHtml;
        oauthBtn.textContent = oauth.reconnectLabel;
      } catch (pollErr) {
        clearInterval(ticker);
        statusDiv.textContent = 'Auth failed: ' + (pollErr instanceof Error ? pollErr.message : String(pollErr));
        oauthBtn.textContent = oauth.connectLabel;
      }
    } catch (err) {
      statusDiv.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
      oauthBtn.textContent = oauth.connectLabel;
    } finally {
      oauthBtn.disabled = false;
    }
  });
}

async function showAddIntegrationModal(section) {
  if (S.plugins.length === 0) await loadPlugins();

  const categoryFilter = getCategoryForSection(section || S.configurationSection);
  const availablePlugins = categoryFilter
    ? S.plugins.filter((p) => pluginSupportsCapability(p, categoryFilter))
    : S.plugins;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
      '<h3>Add Integration</h3>' +
      '<label>Type</label>' +
      '<select data-role="modal-type">' +
        availablePlugins.map((p) => '<option value="' + esc(p.type) + '">' + esc(p.name) + '</option>').join('') +
      '</select>' +
      '<label>Name</label>' +
      '<input data-role="modal-name" placeholder="e.g. Redmine Production" />' +
      '<div data-role="modal-fields"></div>' +
      '<div class="modal-actions">' +
        '<button data-role="modal-cancel">Cancel</button>' +
        '<button data-role="modal-test">Test connection</button>' +
        '<button class="primary" data-role="modal-save">Save</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  const typeSelect = overlay.querySelector('[data-role="modal-type"]');
  const fieldsDiv = overlay.querySelector('[data-role="modal-fields"]');

  function renderFields() {
    const selected = typeSelect.value;
    const plugin = availablePlugins.find((p) => p.type === selected);
    if (!plugin || !fieldsDiv) { if (fieldsDiv) fieldsDiv.innerHTML = ''; return; }
    fieldsDiv.innerHTML = plugin.requiredFields.filter((f) => !f.hidden).map((f) => {
      if (f.type === 'submodule-list') {
        return renderSubmoduleListField([]);
      }
      let fieldHtml;
      if (f.type === 'select' && f.options) {
        fieldHtml =
          '<label>' + esc(f.label) + (f.required ? ' *' : '') + '</label>' +
          '<select data-select-field="' + esc(f.key) + '">' +
            f.options.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('') +
          '</select>';
      } else {
        fieldHtml =
          '<label>' + esc(f.label) + (f.required ? ' *' : '') + '</label>' +
          '<input data-field="' + esc(f.key) + '" type="' + (f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text') + '" placeholder="' + esc(f.placeholder || '') + '" />';
      }
      if (f.dependsOn) {
        return '<div data-depends-on-field="' + esc(f.dependsOn.field) + '" data-depends-on-value="' + esc(f.dependsOn.value) + '" style="display:none">' + fieldHtml + '</div>';
      }
      return fieldHtml;
    }).join('');
    // Provider descriptors may declare an OAuth flow for setup.
    if (plugin?.oauth) {
      initOAuthButton(fieldsDiv, plugin.oauth, {});
    }
    bindSubmoduleListHandlers(fieldsDiv);
    bindDependsOnHandlers(fieldsDiv);
  }

  typeSelect?.addEventListener('change', renderFields);
  renderFields();

  overlay.querySelector('[data-role="modal-cancel"]')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('[data-role="modal-test"]')?.addEventListener('click', async () => {
    const type = typeSelect?.value;
    if (!type) { showActionToast('Select a type first', true); return; }
    const config = collectConfigFields(overlay);
    var submoduleContainer = overlay.querySelector('[data-role="submodule-list"]');
    if (submoduleContainer) {
      var submodules = collectSubmoduleConfigs(submoduleContainer);
      if (submodules.length > 0) config.submodules = submodules;
    }
    const testBtn = overlay.querySelector('[data-role="modal-test"]');
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Testing…'; }
    try {
      const r = await adminFetch('/api/admin/integrations/test', 'POST', JSON.stringify({ type, config }));
      if (r.success) {
        showActionToast('Connection OK', false);
      } else if (r.error) {
        showDetailedError('Connection Failed', r.error);
      } else {
        showDetailedError('Connection Failed', 'Unknown error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showDetailedError('Test Error', msg);
    } finally {
      if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Test connection'; }
    }
  });

  overlay.querySelector('[data-role="modal-save"]')?.addEventListener('click', async () => {
    const type = typeSelect?.value;
    const name = overlay.querySelector('[data-role="modal-name"]')?.value?.trim();
    if (!type || !name) { showActionToast('Name is required', true); return; }

    const config = collectConfigFields(overlay);
    var submoduleContainer = overlay.querySelector('[data-role="submodule-list"]');
    if (submoduleContainer) {
      var submodules = collectSubmoduleConfigs(submoduleContainer);
      if (submodules.length > 0) config.submodules = submodules;
    }

    try {
      await adminFetch('/api/admin/integrations', 'POST', JSON.stringify({ type, name, config }));
      showActionToast(name + ' created', false);
      overlay.remove();
      await loadProviders();
      await loadIntegrations();
    } catch (err) {
      showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
    }
  });
}

// ── Actions ──

async function onActionClick(action, taskId, btn) {
  if (action === 'abandon' && !confirm('Abandon task \u2014 this cannot be undone. Continue?')) return;
  if (action === 'delete' && !confirm('Permanently delete this task from the database? This cannot be undone.')) return;
  btn.disabled = true;
  try {
    if (action === 'delete') {
      await adminFetch('/api/admin/tasks/' + enc(taskId), 'DELETE', null);
      S.selectedTaskId = null;
      S.selectedTask = null;
      showActionToast('Task deleted', false);
      await boot();
      return;
    }
    const method = ['retry', 'abandon'].includes(action) ? 'POST' : 'PATCH';
    await adminFetch('/api/admin/tasks/' + enc(taskId) + '/' + action, method, null);
    showActionToast(action.charAt(0).toUpperCase() + action.slice(1) + ' successful', false);
    await boot();
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
    btn.disabled = false;
  }
}

function showActionToast(message, isError) {
  const div = document.createElement('div');
  div.className = 'action-toast ' + (isError ? 'error' : 'ok');
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

function showDetailedError(title, message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const mainDiv = document.createElement('div');
  mainDiv.className = 'modal';
  mainDiv.innerHTML =
    '<h3>' + esc(title) + '</h3>' +
    '<p style="font-size:12px;color:var(--muted);line-height:1.5;word-break:break-word;white-space:pre-wrap;font-family:monospace;background:var(--panel);padding:12px;border-radius:4px;max-height:200px;overflow-y:auto;">' + esc(message) + '</p>' +
    '<div class="modal-actions">' +
      '<button>Close</button>' +
    '</div>';
  mainDiv.querySelector('button')?.addEventListener('click', () => overlay.remove());
  overlay.appendChild(mainDiv);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Live logs (Server-Sent Events) ──
// ⚠️ SECURITY: Uses fetch() + ReadableStream instead of EventSource to secure auth tokens.
// EventSource does not support custom headers, so auth tokens must go in the URL query string.
// This allows tokens to leak into:
// - Browser history
// - Server access logs (often stored in plaintext)
// - HTTP Referer headers sent to external sites
// - Proxy/CDN logs
// fetch() allows the token in the Authorization header, which is only visible to the direct connection.

let _logsController = null; // AbortController for the fetch-based SSE stream

function connectLogsStream(taskId) {
  if (typeof AbortController === 'undefined' || typeof TextDecoder === 'undefined' || typeof fetch !== 'function') return;
  if (_logsController) { _logsController.abort(); _logsController = null; }
  const out = () => el.detail?.querySelector('[data-role="logs-output"]');
  if (out()) out().innerHTML = '<div class="log-entry">Connecting\u2026</div>';
  const controller = new AbortController();
  _logsController = controller;
  const headers = { Accept: 'text/event-stream' };
  const streamUrl = taskId ? '/api/admin/logs/stream?taskId=' + enc(taskId) : '/api/admin/logs/stream';
  // ⚠️ SECURITY: Auth token transferred to Authorization header instead of URL query param
  if (S.authToken) headers['Authorization'] = 'Bearer ' + S.authToken;
  let fresh = true;
  fetch(streamUrl, { signal: controller.signal, headers })
    .then((res) => {
      if (!res.ok || !res.body) throw new Error('stream unavailable');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      function read() {
        reader.read().then(({ done, value }) => {
          if (done || controller.signal.aborted) return;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\\n\\n');
          buf = parts.pop() || '';
          for (const part of parts) {
            const dataLine = part.split('\\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            try {
              if (fresh) { fresh = false; if (out()) out().innerHTML = ''; }
              addLogLine(JSON.parse(dataLine.slice(5).trim()));
            } catch {}
          }
          read();
        }).catch(() => {
          out()?.insertAdjacentHTML('beforeend', '<div class="log-entry" data-level="error">Stream disconnected.</div>');
        });
      }
      read();
    })
    .catch((err) => {
      if (controller.signal.aborted) return;
      out()?.insertAdjacentHTML('beforeend', '<div class="log-entry" data-level="error">Stream disconnected.</div>');
    });
}

function connectGlobalStream() {
  if (typeof AbortController === 'undefined' || typeof TextDecoder === 'undefined' || typeof fetch !== 'function') return;
  let backoffMs = 1000;
  const maxBackoffMs = 30000;
  let _globalController = null;
  async function connect() {
    if (_globalController) { _globalController.abort(); }
    _globalController = new AbortController();
    const headers = { Accept: 'text/event-stream' };
    if (S.authToken) headers['Authorization'] = 'Bearer ' + S.authToken;
    try {
      const res = await fetch('/api/admin/events/stream', { signal: _globalController.signal, headers });
      if (!res.ok || !res.body) throw new Error('stream unavailable');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done || _globalController.signal.aborted) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line === 'event: tasks' || line === 'event: providers') {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            try {
              const parsed = JSON.parse(raw);
              if (currentEvent === 'tasks') { S.tasks = parsed; renderTasks(); renderStatusBar(); }
              else if (currentEvent === 'providers') { S.providers = parsed; renderProviders(); renderStatusBar(); }
            } catch {}
            currentEvent = '';
          } else if (line === '') {
            currentEvent = '';
          }
        }
      }
      backoffMs = 1000;
      void connect();
    } catch (err) {
      if (_globalController && _globalController.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      void connect();
    }
  }
  void connect();
}

function disconnectLogsStream() {
  if (_logsController) { _logsController.abort(); _logsController = null; }
  const out = el.detail?.querySelector('[data-role="logs-output"]');
  if (out) out.innerHTML = '<div class="log-entry">Logs closed.</div>';
  // Reset session metrics
  S.sessionMetrics = {
    tools: {},
    totalToolCalls: 0,
    activeToolName: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    usageEventCount: 0,
    sessionStartTime: null,
    sessionEndTime: null,
    quotaAvailable: false,
    quotaMessage: 'Not exposed by current SDK/CLI',
  };
}

function renderLogDetail(type, data) {
  if (!data || typeof data !== 'object') return '';

  if (type === 'tool.raw') {
    return '';
  }

  if (type === 'tool.execution_start') {
    return '';
  }

  if (type === 'tool.execution_complete') {
    return '';
  }

  if (type === 'assistant.message') {
    const rawContent = data && typeof data['content'] === 'string' ? data['content'] : null;
    const content = rawContent !== null ? rawContent : (readEventStr(data, ['content', 'text', 'message']) || '');
    if (content) return '<pre class="log-detail-assistant">' + esc(content) + '</pre>';
    return '';
  }

  if (type === 'assistant.usage') {
    const fields = [
      ['inputTokens', 'Input tokens'],
      ['outputTokens', 'Output tokens'],
      ['cacheReadTokens', 'Cache read'],
      ['cacheWriteTokens', 'Cache write'],
      ['totalTokens', 'Total tokens'],
      ['model', 'Model'],
    ];
    const rows = renderDetailTableRows(data, fields);
    return rows ? '<table class="log-detail-table">' + rows + '</table>' : '';
  }

  if (type === 'session.usage_info') {
    const fields = [
      ['tokenLimit', 'Token limit'],
      ['currentTokens', 'Current tokens'],
      ['messagesLength', 'Messages'],
      ['systemTokens', 'System tokens'],
      ['conversationTokens', 'Conversation tokens'],
      ['toolDefinitionsTokens', 'Tool definitions'],
      ['isInitial', 'Initial snapshot'],
      ['model', 'Model'],
    ];
    const rows = renderDetailTableRows(data, fields);
    return rows ? '<table class="log-detail-table">' + rows + '</table>' : '';
  }

  if (type === 'session.start') {
    const fields = [['model','Model'],['workingDirectory','Working dir'],['cliUrl','CLI URL']];
    const rows = renderDetailTableRows(data, fields);
    return rows ? '<table class="log-detail-table">' + rows + '</table>' : '';
  }

  if (type === 'session.end') {
    const rows = Object.entries(data)
      .map(([k, v]) => '<tr><td class="log-detail-key">' + esc(k) + '</td>' +
        '<td class="log-detail-val">' + esc(String(v)) + '</td></tr>')
      .join('');
    return rows ? '<table class="log-detail-table">' + rows + '</table>' : '';
  }

  // Fallback: JSON dump for anything else
  try {
    const json = JSON.stringify(data, null, 2);
    if (json === '{}' || json === 'null') return '';
    return '<pre class="log-detail-json">' + esc(json) + '</pre>';
  } catch {
    return '';
  }
}

function addLogLine(entry) {
  const out = el.detail?.querySelector('[data-role="logs-output"]');
  if (!out) return;
  const ts  = new Date(entry.timestamp).toLocaleTimeString();
  const lvl = (entry.level || 'info').toLowerCase();
  const cat = entry.category || 'all';
  const display = getLogDisplayProps(entry);
  const evtType = display.eventType;

  if (shouldSuppressLiveLogEntry(entry)) {
    updateMetricsFromEntry(entry);
    renderMetrics();
    return;
  }

  const div = document.createElement('div');
  div.setAttribute('data-level', lvl);
  div.setAttribute('data-category', cat);

  // Build structured log line
  const tsSpan = '<span class="log-ts">' + esc(ts) + '</span>';
  const typeBadge = evtType ? '<span class="log-type-badge" data-cat="' + esc(cat) + '">' + esc(formatEventType(evtType)) + '</span>' : '';
  const msgSpan = '<span class="log-msg">' + esc(display.message) + '</span>';

  const detailHtml = renderLogDetail(evtType, entry.data);
  const hasDetail = detailHtml.length > 0;

  if (hasDetail) {
    div.className = 'log-entry expandable';
    div.innerHTML = tsSpan + typeBadge + msgSpan +
      '<span class="log-expand-hint">›</span>' +
      '<div class="log-detail">' + detailHtml + '</div>';
    div.addEventListener('click', () => {
      const detail = div.querySelector('.log-detail');
      const hint = div.querySelector('.log-expand-hint');
      const isOpen = detail.classList.contains('open');
      detail.classList.toggle('open', !isOpen);
      if (hint) hint.textContent = isOpen ? '›' : '⌄';
    });
  } else {
    div.className = 'log-entry';
    div.innerHTML = tsSpan + typeBadge + msgSpan;
  }

  // Apply current filter: 'all' category entries always visible, others filtered
  if (S.logsFilter !== 'all' && cat !== S.logsFilter && cat !== 'all') {
    div.style.display = 'none';
  }
  // Hide entries whose specific category doesn't match the filter
  if (S.logsFilter !== 'all' && cat === 'all') {
    div.style.display = 'none';
  }

  // Deduplicate consecutive identical heartbeat/working messages
  const lastEntry = out.lastElementChild;
  if (lastEntry && lastEntry.getAttribute('data-category') === 'all' && cat === 'all') {
    const lastMsg = lastEntry.querySelector('.log-msg')?.textContent || '';
    const newMsg = entry.message || '';
    if (lastMsg === newMsg && newMsg.includes('agent working')) {
      // Skip duplicate heartbeat
      return;
    }
  }

  out.appendChild(div);
  out.scrollTop = out.scrollHeight;

  // Update metrics from event
  updateMetricsFromEntry(entry);
  renderMetrics();
}

function getLogDisplayProps(entry) {
  const type = entry?.type || '';
  const rawLine = readEventStr(entry?.data || null, ['line']) || '';
  const rawMessage = typeof entry?.message === 'string' ? entry.message : '';
  const message = rawMessage || rawLine;

  if (type === 'stderr.line' && message.startsWith('[tool]')) {
    return {
      eventType: 'tool.raw',
      message: message.slice('[tool]'.length).trimStart(),
    };
  }

  return {
    eventType: type,
    message,
  };
}

function shouldSuppressLiveLogEntry(entry) {
  const type = entry?.type || '';
  if (type === 'tool.execution_start') return true;
  if (type === 'permission.requested') return true;
  if (type === 'tool.execution_complete') {
    const status = readEventStr(entry?.data || null, ['status', 'result']);
    return status !== 'error';
  }
  if (type === 'assistant.message') {
    const rawContent = entry?.data && typeof entry.data['content'] === 'string' ? entry.data['content'] : null;
    const content = rawContent !== null ? rawContent : (readEventStr(entry?.data || null, ['content', 'text', 'message']) || '');
    return !content;
  }
  return false;
}

function formatEventType(type) {
  if (!type) return '';
  const labels = {
    'tool.execution_start': 'tool start',
    'tool.execution_complete': 'tool complete',
    'tool.execution_progress': 'tool progress',
    'tool.raw': 'tool',
    'assistant.message': 'assistant',
    'assistant.streaming_delta': 'assistant stream',
    'assistant.usage': 'model usage',
    'session.start': 'session start',
    'session.end': 'session end',
    'session.usage_info': 'context usage',
    'session.error': 'session error',
    'permission.requested': 'permission',
    'stderr.line': 'log',
  };
  if (labels[type]) return labels[type];
  if (type === 'assistant.usage') return 'model usage';
  if (type === 'session.usage_info') return 'context usage';
  // Shorten common prefixes
  return type
    .replace('tool.execution_', 'tool.')
    .replace('assistant.', 'ai.')
    .replace('session.', 'sess.')
    .replace('stderr.line', 'log');
}

function updateMetricsFromEntry(entry) {
  const m = S.sessionMetrics;
  const type = entry.type || '';
  const data = entry.data || {};

  if (type === 'session.start') {
    m.tools = {};
    m.totalToolCalls = 0;
    m.activeToolName = null;
    m.tokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    m.usageEventCount = 0;
    m.sessionStartTime = entry.timestamp;
    m.sessionEndTime = null;
    return;
  }

  if (type === 'session.end') {
    m.sessionEndTime = entry.timestamp;
    m.activeToolName = null;
    return;
  }

  if (type === 'tool.execution_start') {
    const name = readEventStr(data, ['name', 'tool', 'toolName', 'tool_name']) || 'tool';
    m.totalToolCalls++;
    m.activeToolName = name;
    if (!m.tools[name]) {
      m.tools[name] = { name: name, callCount: 0, lastStatus: 'unknown', lastStartTime: null, lastEndTime: null, lastDurationMs: null, totalDurationMs: 0 };
    }
    m.tools[name].callCount++;
    m.tools[name].lastStatus = 'running';
    m.tools[name].lastStartTime = entry.timestamp;
    return;
  }

  if (type === 'tool.execution_complete') {
    const name = readEventStr(data, ['name', 'tool', 'toolName', 'tool_name']) || 'tool';
    if (m.activeToolName === name) m.activeToolName = null;
    const t = m.tools[name];
    if (t) {
      t.lastStatus = readEventStr(data, ['status', 'result']) === 'error' ? 'error' : 'success';
      t.lastEndTime = entry.timestamp;
      const durationMs = readEventNum(data, ['durationMs']);
      if (durationMs !== null) {
        t.lastDurationMs = durationMs;
        t.totalDurationMs += durationMs;
      } else if (t.lastStartTime) {
        const dur = new Date(entry.timestamp).getTime() - new Date(t.lastStartTime).getTime();
        if (dur >= 0) { t.lastDurationMs = dur; t.totalDurationMs += dur; }
      }
    }
    return;
  }

  if (type === 'assistant.usage' || type === 'session.usage_info') {
    m.usageEventCount++;
    updateCumulativeTokenUsage(m.tokenUsage, data);
    return;
  }
}

function renderMetrics() {
  const m = S.sessionMetrics;
  const setMetric = (key, value) => {
    const el2 = el.detail?.querySelector('[data-metric="' + key + '"]');
    if (el2) el2.textContent = String(value);
  };
  const setMetricClass = (key, cls) => {
    const el2 = el.detail?.querySelector('[data-metric="' + key + '"]');
    if (el2) { el2.className = 'metric-value' + (cls ? ' ' + cls : ''); }
  };

  setMetric('active-tool', m.activeToolName || '\\u2014');
  setMetricClass('active-tool', m.activeToolName ? 'active' : '');
  setMetric('tool-calls', String(m.totalToolCalls));
  setMetric('input-tokens', formatTokenCount(m.tokenUsage.inputTokens));
  setMetric('output-tokens', formatTokenCount(m.tokenUsage.outputTokens));
  setMetric('cache-read', formatTokenCount(m.tokenUsage.cacheReadTokens));
  setMetric('cache-write', formatTokenCount(m.tokenUsage.cacheWriteTokens));
}

function formatTokenCount(n) {
  if (n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function applyLogsFilter() {
  const out = el.detail?.querySelector('[data-role="logs-output"]');
  if (!out) return;
  out.querySelectorAll('.log-entry').forEach((entry) => {
    const cat = entry.getAttribute('data-category') || 'all';
    if (S.logsFilter === 'all') {
      // Show everything
      entry.style.display = '';
    } else if (cat === S.logsFilter) {
      // Matches the selected filter
      entry.style.display = '';
    } else {
      // Hide non-matching entries (including cat='all' generic entries)
      entry.style.display = 'none';
    }
  });
}

// ── Fetch ──

async function adminFetch(path, method, body) {
  const headers = new Headers();
  if (S.authToken) headers.set('authorization', 'Bearer ' + S.authToken);
  if (body) headers.set('content-type', 'application/json');
  const res = await fetch(path, { method: method || 'GET', headers, body: body || undefined });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    let errMsg = 'HTTP ' + res.status;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error) {
        errMsg = (errBody.message || errBody.error);
        // Append field-level details only when the top-level error/message
        // is generic (i.e. doesn't already mention the offending fields).
        const details = errBody.details;
        const looksDetailed = /[:›]/.test(errMsg);
        if (!looksDetailed && details && typeof details === 'object') {
          const parts = [];
          if (Array.isArray(details.formErrors)) {
            for (const m of details.formErrors) if (m) parts.push(String(m));
          }
          const fe = details.fieldErrors;
          if (fe && typeof fe === 'object') {
            for (const k of Object.keys(fe)) {
              const msgs = fe[k];
              if (Array.isArray(msgs) && msgs.length > 0) {
                parts.push(k + ': ' + msgs.join(', '));
              }
            }
          }
          if (parts.length > 0) errMsg = errMsg + ' — ' + parts.join('; ');
        }
      }
    } catch { /* ignore parse errors */ }
    throw new Error(errMsg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isUnauthorized(err) { return err instanceof Error && err.message === 'unauthorized'; }

// ── Helpers ──

function tone(state) {
  const s = (state || '').toUpperCase();
  if (['RUNNING', 'IN_REVIEW', 'DONE', 'READY', 'SUCCESS', 'MERGED', 'REVIEW_DONE'].includes(s)) return 'ok';
  if (['FAILED', 'ABANDONED', 'INCOMPLETE', 'ERROR', 'RETRY_CYCLE', 'REVIEW_FAILED'].includes(s))   return 'bad';
  if (['DETECTED', 'CONTEXT_BUILDING', 'AGENT_RUNNING', 'CLOSING', 'FEEDBACK_PROCESSING', 'PAUSED', 'REVIEW_RUNNING', 'REVIEW_PENDING', 'REVIEW_COMMENTING', 'REVIEW_WATCHING'].includes(s)) return 'warn';
  return 'neutral';
}

function provTone(status) {
  if (status === 'ready')    return 'ok';
  if (status === 'disabled') return 'neutral';
  return 'bad';
}

function tabBtn(id, label) {
  return '<button class="tab' + (S.activeTab === id ? ' active' : '') + '" data-tab="' + esc(id) + '">' + esc(label) + '</button>';
}

function metaCard(label, value) {
  return (
    '<div class="meta-card">' +
      '<div class="meta-label">' + esc(label) + '</div>' +
      '<div class="meta-value">' + esc(value) + '</div>' +
    '</div>'
  );
}

function q(sel) { return document.querySelector(sel); }
function fmt(v) { return new Date(v).toLocaleString(); }
function enc(v) { return encodeURIComponent(v); }
function esc(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncatePrompt(value) {
  const text = String(value || '');
  if (text.length <= 180) return text;
  return text.slice(0, 177) + '...';
}

function replaceDelimited(text, marker, openTag, closeTag) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(marker, index);
    if (start === -1) {
      out += text.slice(index);
      break;
    }
    const end = text.indexOf(marker, start + marker.length);
    if (end === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start) + openTag + text.slice(start + marker.length, end) + closeTag;
    index = end + marker.length;
  }
  return out;
}

function renderRichInline(v) {
  let html = esc(String(v || ''));
  const codeMarker = String.fromCharCode(96);

  html = replaceDelimited(html, codeMarker, '<code>', '</code>');
  html = replaceDelimited(html, '**', '<strong>', '</strong>');
  html = replaceDelimited(html, '__', '<u>', '</u>');
  html = replaceDelimited(html, '~~', '<s>', '</s>');
  html = replaceDelimited(html, '*', '<em>', '</em>');
  html = replaceDelimited(html, '_', '<em>', '</em>');

  return html;
}

function resolveRichAssetUrl(url, baseUrl) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl).toString() : raw;
    if (/^javascript:/i.test(resolved) || /^data:/i.test(resolved)) return null;
    return resolved;
  } catch {
    if (/^https?:\\/\\//i.test(raw) && !/^javascript:/i.test(raw) && !/^data:/i.test(raw)) return raw;
    if (raw.startsWith('/')) return raw;
    return null;
  }
}

function parseImageLine(line) {
  const match = String(line || '').trim().match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)/);
  if (!match) return null;
  return { alt: match[1], url: match[2] };
}

function renderRichImage(image, options) {
  const src = resolveRichAssetUrl(image.url, options?.baseUrl);
  if (!src) return '<div>' + renderRichInline('![image](' + image.url + ')') + '</div>';
  const finalSrc = options?.proxyPrefix ? options.proxyPrefix + encodeURIComponent(src) : src;
  return '<div class="rich-image"><img src="' + esc(finalSrc) + '" alt="' + esc(image.alt || '') + '" loading="lazy" /></div>';
}

function parseHeading(line) {
  if (!line.startsWith('#')) return null;
  let level = 0;
  while (level < line.length && line[level] === '#') level += 1;
  if (level < 1 || level > 3) return null;
  if (line[level] !== ' ') return null;
  return { level, text: line.slice(level + 1) };
}

function parseUnorderedItem(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) return trimmed.slice(2);
  return null;
}

function parseOrderedItem(line) {
  const trimmed = line.trimStart();
  let index = 0;
  while (index < trimmed.length && trimmed[index] >= '0' && trimmed[index] <= '9') index += 1;
  if (index === 0 || trimmed.slice(index, index + 2) !== '. ') return null;
  return trimmed.slice(index + 2);
}

function renderRichText(v, options) {
  const carriageReturn = String.fromCharCode(13);
  const lineFeed = String.fromCharCode(10);
  const normalized = String(v || '').split(carriageReturn).join('').replace(/<br\\s*\\/?>/gi, lineFeed);
  const lines = normalized.split(lineFeed);
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push('<div>' + paragraph.map((line) => renderRichInline(line)).join('<br />') + '</div>');
    paragraph = [];
  }

  function flushList() {
    if (!listType || listItems.length === 0) return;
    blocks.push('<' + listType + '>' + listItems.map((item) => '<li>' + renderRichInline(item) + '</li>').join('') + '</' + listType + '>');
    listType = null;
    listItems = [];
  }

  for (const line of lines) {
    const heading = parseHeading(line);
    const unorderedItem = parseUnorderedItem(line);
    const orderedItem = parseOrderedItem(line);
    const image = parseImageLine(line);

    if (heading) {
      flushList();
      flushParagraph();
      blocks.push('<h' + heading.level + '>' + renderRichInline(heading.text) + '</h' + heading.level + '>');
      continue;
    }

    if (unorderedItem !== null) {
      flushParagraph();
      if (listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(unorderedItem);
      continue;
    }

    if (orderedItem !== null) {
      flushParagraph();
      if (listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(orderedItem);
      continue;
    }

    if (image) {
      flushList();
      flushParagraph();
      blocks.push(renderRichImage(image, options));
      continue;
    }

    flushList();
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushList();
  flushParagraph();

  return blocks.join('');
}

function storedToken()    { try { return localStorage.getItem('ve-admin-token'); } catch { return null; } }
function storeToken(t)    { try { localStorage.setItem('ve-admin-token', t); } catch {} }
function clearToken()     { try { localStorage.removeItem('ve-admin-token'); } catch {} }
function storedSecret()   { try { return localStorage.getItem('ve-admin-secret'); } catch { return null; } }
function storeSecret(s)   { try { localStorage.setItem('ve-admin-secret', s); } catch {} }
function clearSecret()    { try { localStorage.removeItem('ve-admin-secret'); } catch {} }
async function computeToken(secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(ts));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return ts + '.' + hex;
}

function ticketLink(task) {
  const url = task.ticketUrl || null;
  if (!url) return null;
  // ⚠️ SECURITY: Block javascript: and data: URIs that could execute code if clicked
  if (/^javascript:/i.test(url) || /^data:/i.test(url)) return null;
  return url;
}

function reviewLink(task) {
  // Prefer task-level reviewUrl; fall back to first available CPR reviewUrl
  const url = task.reviewUrl
    || task.changesPerRepo?.find((c) => c.reviewUrl)?.reviewUrl
    || null;
  if (!url) return null;
  // ⚠️ SECURITY: Block javascript: and data: URIs that could execute code if clicked
  if (/^javascript:/i.test(url) || /^data:/i.test(url)) return null;
  return url;
}

// ─── Phase 3: Agents Library + Projects ─────────────────────────────────────

function renderAgentsLibrary() {
  if (!el.configurationContent) return;
  if (S.agents.length === 0) {
    el.configurationContent.innerHTML =
      '<div class="resource-table" data-role="agents-library-table">' +
        '<div class="agent-empty">' + esc('No agents defined yet. Click "+ New Agent" to create one.') + '</div>' +
      '</div>';
    return;
  }

  el.configurationContent.innerHTML =
    '<div class="resource-table" data-role="agents-library-table">' +
      '<div class="resource-table-head agent-table-head">' +
        '<div>Name</div>' +
        '<div>Type</div>' +
        '<div>Model</div>' +
        '<div>Actions</div>' +
        '<div>Details</div>' +
      '</div>' +
      S.agents.map((agent) => renderAgentRow(agent)).join('') +
    '</div>';

  el.configurationContent.querySelectorAll('[data-select-agent-id]').forEach((row) => {
    row.addEventListener('click', () => toggleAgentDrawer(row.getAttribute('data-select-agent-id')));
  });
  el.configurationContent.querySelectorAll('[data-expand-agent-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAgentDrawer(button.getAttribute('data-expand-agent-id'));
    });
  });
  bindAgentActionHandlers(el.configurationContent);
}

function renderAgentRow(agent) {
  const isSelected = agent.id === S.selectedAgentId;
  const isExpanded = isSelected && S.agentDrawerOpen;
  const selected = isSelected ? ' is-selected' : '';
  const expanded = isExpanded ? ' is-expanded' : '';
  return (
    '<div class="integration-row-wrap">' +
      '<div class="agent-row' + selected + expanded + '" data-select-agent-id="' + esc(agent.id) + '">' +
        '<div class="integration-primary">' +
          '<div class="integration-name">' + esc(agent.name) + '</div>' +
          '<div class="integration-subtitle">ID ' + esc(agent.id) + '</div>' +
        '</div>' +
        '<div class="integration-cell">' + esc(agent.type) + '</div>' +
        '<div class="integration-cell muted">' + esc(agent.model || '—') + '</div>' +
        '<div class="integration-quick-actions">' +
          '<button class="toggle' + (agent.enabled ? ' on' : '') + '" data-toggle-agent-id="' + esc(agent.id) + '" title="' + (agent.enabled ? 'Disable' : 'Enable') + '"></button>' +
          '<button class="icon-btn" data-edit-agent-id="' + esc(agent.id) + '" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
          '<button class="icon-btn danger" data-delete-agent-id="' + esc(agent.id) + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>' +
        '</div>' +
        '<div class="integration-cell">' +
          '<button class="integration-row-expand" data-expand-agent-id="' + esc(agent.id) + '">' +
            '<span class="integration-row-chevron">' + (isExpanded ? '▲' : '▼') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      (isExpanded ? renderExpandedAgentDetails(agent) : '') +
    '</div>'
  );
}

function renderExpandedAgentDetails(agent) {
  var agentIntegrations = S.integrations.filter(function(i) { return integrationSupportsCapability(i, 'agent'); });
  var integrationNameMap = {};
  agentIntegrations.forEach(function(i) { integrationNameMap[i.id] = i.name || i.type; });
  var systemPrompt = agent.systemPromptId ? S.prompts.find(p => p.id === agent.systemPromptId) : null;
  var instructionsPrompt = agent.instructionsPromptId ? S.prompts.find(p => p.id === agent.instructionsPromptId) : null;
  
  return (
    '<div class="integration-row-details" data-agent-details-for="' + esc(agent.id) + '">' +
      '<div class="integration-row-details-grid">' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title"><strong>Summary</strong></div>' +
          renderSettingRows([
            ['Type', agent.type],
            ['AI Adapter', agent.integrationId && integrationNameMap[agent.integrationId] ? integrationNameMap[agent.integrationId] : '—'],
            ['Model', agent.model || '—'],
            ['Max Concurrent', String(agent.maxConcurrent)],
            ['Status', agent.enabled ? 'Enabled' : 'Disabled'],
            ['Projects', String(agent.projectCount)],
            ['Created', fmt(agent.createdAt)],
            ['Updated', fmt(agent.updatedAt)],
          ]) +
        '</div>' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title"><strong>Prompts</strong></div>' +
          renderSettingRows([
            ['System Prompt', systemPrompt ? systemPrompt.label || systemPrompt.id : '—'],
            ['Instructions Prompt', instructionsPrompt ? instructionsPrompt.label || instructionsPrompt.id : '—'],
          ]) +
        '</div>' +
        '<div class="integration-row-details-panel integration-row-details-wide">' +
          '<div class="integration-row-details-title"><strong>Actions</strong></div>' +
          '<div class="integration-row-details-actions">' +
            '<button data-role="agent-inline-toggle">' + esc(agent.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="primary" data-role="agent-inline-edit">Edit Agent</button>' +
            '<button class="danger" data-role="agent-inline-delete">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function toggleAgentDrawer(agentId) {
  if (!agentId) return;
  if (S.selectedAgentId === agentId) {
    S.agentDrawerOpen = !S.agentDrawerOpen;
  } else {
    S.selectedAgentId = agentId;
    S.agentDrawerOpen = true;
  }
  S.agentDrawerMode = 'view';
  renderAgentsLibrary();
}

function closeAgentDrawer() {
  S.agentDrawerOpen = false;
  S.agentDrawerMode = 'view';
  renderAgentsLibrary();
}

function bindAgentActionHandlers(root) {
  root.querySelectorAll('[data-toggle-agent-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = btn.getAttribute('data-toggle-agent-id');
      void toggleAgentStatus(agentId);
    });
  });
  root.querySelectorAll('[data-edit-agent-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = btn.getAttribute('data-edit-agent-id');
      void editAgent(agentId);
    });
  });
  root.querySelectorAll('[data-delete-agent-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = btn.getAttribute('data-delete-agent-id');
      void deleteAgent(agentId);
    });
  });
  root.querySelectorAll('[data-role="agent-inline-toggle"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = S.selectedAgentId;
      if (agentId) void toggleAgentStatus(agentId);
    });
  });
  root.querySelectorAll('[data-role="agent-inline-edit"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = S.selectedAgentId;
      if (agentId) void editAgent(agentId);
    });
  });
  root.querySelectorAll('[data-role="agent-inline-delete"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = S.selectedAgentId;
      if (agentId) void deleteAgent(agentId);
    });
  });
}

async function toggleAgentStatus(agentId) {
  try {
    const agent = S.agents.find(a => a.id === agentId);
    if (!agent) return;
    await adminFetch('/api/admin/agents/' + enc(agentId) + '/' + (agent.enabled ? 'disable' : 'enable'), 'PATCH');
    await loadAgents();
    showActionToast(agent.enabled ? 'Agent disabled' : 'Agent enabled', false);
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function editAgent(agentId) {
  try {
    const r = await adminFetch('/api/admin/agents/' + enc(agentId));
    showAgentModal(r.agent);
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function deleteAgent(agentId) {
  try {
    if (!confirm('Delete this agent?')) return;
    await adminFetch('/api/admin/agents/' + enc(agentId), 'DELETE');
    await loadAgents();
    showActionToast('Agent deleted', false);
    S.selectedAgentId = null;
    S.agentDrawerOpen = false;
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

function showAgentModal(existing) {
  var isEdit = Boolean(existing);
  var promptOptions = ['<option value="">— none —</option>'].concat(
    S.prompts.map(function(p) { return '<option value="' + esc(p.id) + '">' + esc(p.label || p.id) + '</option>'; })
  ).join('');
  var cfg = (existing && existing.modelConfig) || {};
  var agentIntegrations = S.integrations.filter(function(i) { return integrationSupportsCapability(i, 'agent'); });
  var integrationOptions = '<option value="">— select AI adapter —</option>' +
    agentIntegrations.map(function(i) {
      var sel = (existing && existing.integrationId === i.id) ? ' selected' : '';
      return '<option value="' + esc(i.id) + '"' + sel + '>' + esc(i.name || i.type) + '</option>';
    }).join('');
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
      '<h3>' + (isEdit ? 'Edit Agent' : 'New Agent') + '</h3>' +
      '<label>Name</label>' +
      '<input data-f="name" value="' + esc((existing && existing.name) || '') + '" />' +
      '<label>Type</label>' +
      '<select data-f="type"' + (isEdit ? ' disabled' : '') + '>' +
        '<option value="coding"' + ((existing && existing.type) === 'coding' ? ' selected' : '') + '>coding</option>' +
        '<option value="review"' + ((existing && existing.type) === 'review' ? ' selected' : '') + '>review</option>' +
      '</select>' +
      '<label>AI Adapter</label>' +
      '<select data-f="integrationId">' + integrationOptions + '</select>' +
      '<label>Model <button type="button" data-role="refresh-models" title="Refresh model list" style="font-size:0.75em;padding:1px 5px;cursor:pointer;margin-left:4px">↻</button></label>' +
      '<select data-f="model"><option value="">— select AI adapter first —</option></select>' +
      '<label data-role="reasoning-label" style="display:none">Reasoning Level</label>' +
      '<select data-f="reasoningEffort" data-role="reasoning-select" style="display:none">' +
        '<option value="">— default —</option>' +
      '</select>' +
      '<label>System Prompt</label>' +
      '<select data-f="systemPromptId">' + promptOptions + '</select>' +
      '<label>Instructions Prompt</label>' +
      '<select data-f="instructionsPromptId">' + promptOptions + '</select>' +
      '<label>Max Concurrent</label>' +
      '<input type="number" min="1" data-f="maxConcurrent" value="' + esc(String((existing && existing.maxConcurrent) || 1)) + '" />' +
      '<div class="modal-actions">' +
        '<button data-role="cancel">Cancel</button>' +
        '<button class="primary" data-role="save">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // Populate model dropdown from AI adapter's discovered models
  var modelSelect = overlay.querySelector('[data-f="model"]');
  var integrationSelect = overlay.querySelector('[data-f="integrationId"]');
  var reasoningLabel = overlay.querySelector('[data-role="reasoning-label"]');
  var reasoningSelect = overlay.querySelector('[data-role="reasoning-select"]');
  var cachedModels = [];
  
  function formatModelOption(m) {
    var parts = [esc(m.name)];
    if (m.capabilities && m.capabilities.type) {
      parts.push('[' + esc(m.capabilities.type) + ']');
    }
    if (m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0) {
      parts.push('[reasoning]');
    }
    var details = [];
    if (m.contextWindowTokens) {
      var ctxK = Math.round(m.contextWindowTokens / 1000);
      details.push(ctxK + 'k ctx');
    }
    if (details.length > 0) {
      parts.push('(' + details.join(', ') + ')');
    }
    return parts.join(' ');
  }
  
  function updateReasoningSelect(selectedModelId, preselectedEffort) {
    var model = cachedModels.find(function(m) { return m.id === selectedModelId; });
    var efforts = model && model.supportedReasoningEfforts;
    if (efforts && efforts.length > 0) {
      var opts = '<option value="">— default —</option>' +
        efforts.map(function(e) {
          var sel = (preselectedEffort === e) ? ' selected' : '';
          return '<option value="' + esc(e) + '"' + sel + '>' + esc(e) + '</option>';
        }).join('');
      reasoningSelect.innerHTML = opts;
      reasoningLabel.style.display = '';
      reasoningSelect.style.display = '';
    } else {
      reasoningSelect.innerHTML = '<option value="">— default —</option>';
      reasoningLabel.style.display = 'none';
      reasoningSelect.style.display = 'none';
    }
  }

  function loadModelsForIntegration(integrationId, preselect) {
    modelSelect.innerHTML = '<option value="">Loading models…</option>';
    if (!integrationId) {
      modelSelect.innerHTML = '<option value="">— select AI adapter first —</option>';
      return;
    }
    adminFetch('/api/admin/integrations/' + enc(integrationId) + '/models')
      .then(function(r) {
        var models = r.models || [];
        if (models.length === 0) {
          modelSelect.innerHTML = '<option value="">Discovering models…</option>';
          return adminFetch('/api/admin/integrations/' + enc(integrationId) + '/discover', 'POST')
            .then(function() {
              return adminFetch('/api/admin/integrations/' + enc(integrationId) + '/models');
            })
            .then(function(r2) {
              var discovered = r2.models || [];
              if (discovered.length === 0) {
                modelSelect.innerHTML = '<option value="">No models available — check AI Adapters config</option>';
                return;
              }
              var opts = discovered.map(function(m) {
                var sel = (preselect && m.id === preselect) ? ' selected' : '';
                return '<option value="' + esc(m.id) + '"' + sel + '>' + formatModelOption(m) + '</option>';
              }).join('');
              modelSelect.innerHTML = opts;
              cachedModels = discovered;
              updateReasoningSelect(modelSelect.value, cfg.reasoningEffort || null);
            })
            .catch(function(e) {
              modelSelect.innerHTML = '<option value="">Failed to discover models — check API key</option>';
            });
        }
        var opts = models.map(function(m) {
          var sel = (preselect && m.id === preselect) ? ' selected' : '';
          return '<option value="' + esc(m.id) + '"' + sel + '>' + formatModelOption(m) + '</option>';
        }).join('');
        modelSelect.innerHTML = opts;
        cachedModels = models;
        updateReasoningSelect(modelSelect.value, cfg.reasoningEffort || null);
      })
      .catch(function() {
        modelSelect.innerHTML = '<option value="">Failed to load models</option>';
      });
  }
  integrationSelect.addEventListener('change', function() {
    loadModelsForIntegration(integrationSelect.value, null);
  });
  modelSelect.addEventListener('change', function() {
    updateReasoningSelect(modelSelect.value, null);
  });
  var refreshBtn = overlay.querySelector('[data-role="refresh-models"]');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      var intId = integrationSelect.value;
      if (!intId) return;
      refreshBtn.disabled = true;
      adminFetch('/api/admin/integrations/' + enc(intId) + '/discover', 'POST')
        .then(function() { loadModelsForIntegration(intId, modelSelect.value || null); })
        .catch(function() { loadModelsForIntegration(intId, modelSelect.value || null); })
        .finally(function() { refreshBtn.disabled = false; });
    });
  }
  // Pre-load models if editing with an existing integration
  if (existing && existing.integrationId) {
    loadModelsForIntegration(existing.integrationId, cfg.model || null);
  }

  if (existing && existing.systemPromptId) {
    var sel = overlay.querySelector('[data-f="systemPromptId"]');
    if (sel) sel.value = existing.systemPromptId;
  }
  if (existing && existing.instructionsPromptId) {
    var sel2 = overlay.querySelector('[data-f="instructionsPromptId"]');
    if (sel2) sel2.value = existing.instructionsPromptId;
  }
  overlay.querySelector('[data-role="cancel"]').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('[data-role="save"]').addEventListener('click', async function() {
    var get = function(k) {
      var node = overlay.querySelector('[data-f="' + k + '"]');
      if (!node) return undefined;
      if (node.type === 'checkbox') return node.checked;
      return node.value;
    };
    var modelConfig = {};
    var model = get('model');
    if (model) modelConfig.model = model;
    var reasoningEffort = get('reasoningEffort');
    if (reasoningEffort) modelConfig.reasoningEffort = reasoningEffort;
    var payload = {
      name: get('name'),
      type: get('type'),
      modelConfig: modelConfig,
      integrationId: get('integrationId') || null,
      systemPromptId: get('systemPromptId') || null,
      instructionsPromptId: get('instructionsPromptId') || null,
      maxConcurrent: Number(get('maxConcurrent')) || 1,
    };
    try {
      if (isEdit) {
        delete payload.type;
        await adminFetch('/api/admin/agents/' + enc(existing.id), 'PUT', JSON.stringify(payload));
      } else {
        await adminFetch('/api/admin/agents', 'POST', JSON.stringify(payload));
      }
      overlay.remove();
      await loadAgents();
      showActionToast(isEdit ? 'Agent updated' : 'Agent created', false);
    } catch (err) {
      showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
    }
  });
}

function bindConcurrencyPanel() {
  if (!el.configurationContent) return;
  const snap = el.configurationContent.querySelector('span[data-role="concurrency-snapshot"]');
  if (!snap) return;
  adminFetch('/api/admin/concurrency').then((r) => {
    if (r.snapshot) {
      const s = r.snapshot;
      const active = s.global ?? 0;
      const adapters = Object.entries(s.perAgent || {}).map(([k, v]) => k + ':' + String(v)).join(', ');
      snap.textContent = 'Active runs: ' + String(active)
        + (adapters ? ' (' + adapters + ')' : '');
    }
  }).catch(() => { /* ignore */ });
}

function renderProjectsSection() {
  if (!el.configurationContent) return;
  // Phase 6 — minimal concurrency panel above the projects table.
  const concurrencyPanel =
    '<div class="configuration-panel" data-role="concurrency-panel"><div class="configuration-panel-body">' +
      '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">' +
        '<strong>Agent adapter concurrency</strong>' +
        '<span data-role="concurrency-snapshot" style="color:#666;">Active runs: —</span>' +
        '<small style="color:#999;">Limit is set per-agent in the Agents Library (Max Concurrent).</small>' +
      '</div>' +
    '</div></div>';
  if (S.projects.length === 0) {
    el.configurationContent.innerHTML =
      concurrencyPanel +
      '<div class="resource-table" data-role="projects-table">' +
        '<div class="project-empty">No projects yet. Click "+ New Project" to create one.</div>' +
      '</div>';
    bindConcurrencyPanel();
    return;
  }
  el.configurationContent.innerHTML =
    concurrencyPanel +
    '<div class="resource-table" data-role="projects-table">' +
      '<div class="resource-table-head project-table-head">' +
        '<div>Name</div>' +
        '<div>Type</div>' +
        '<div>Source / Target</div>' +
        '<div>Actions</div>' +
        '<div>Details</div>' +
      '</div>' +
      S.projects.map((p) => renderProjectRow(p)).join('') +
    '</div>';
  bindConcurrencyPanel();
  el.configurationContent.querySelectorAll('[data-select-project-id]').forEach((row) => {
    row.addEventListener('click', () => toggleProjectDrawer(row.getAttribute('data-select-project-id')));
  });
  el.configurationContent.querySelectorAll('[data-expand-project-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleProjectDrawer(button.getAttribute('data-expand-project-id'));
    });
  });
  bindProjectActionHandlers(el.configurationContent);
}

function projectSourceTargetLabel(p) {
  if (p.type === 'coding') {
    return p.ticketSource
      ? ((p.ticketSource.integration && p.ticketSource.integration.name) || '?') + ' / ' + p.ticketSource.ticketProjectKey
      : '—';
  }
  return p.reviewConfig
    ? ((p.reviewConfig.integration && p.reviewConfig.integration.name) || '?') + ' (' + String((p.reviewConfig.repos || []).length) + ' repo' + ((p.reviewConfig.repos || []).length === 1 ? '' : 's') + ')'
    : '—';
}

function renderProjectRow(p) {
  const isSelected = p.id === S.selectedProjectId;
  const isExpanded = isSelected && S.projectDrawerOpen;
  const selected = isSelected ? ' is-selected' : '';
  const expanded = isExpanded ? ' is-expanded' : '';
  const stLabel = projectSourceTargetLabel(p);
  return (
    '<div class="integration-row-wrap">' +
      '<div class="project-row' + selected + expanded + '" data-select-project-id="' + esc(p.id) + '">' +
        '<div class="integration-primary">' +
          '<div class="integration-name">' + esc(p.name) + '</div>' +
          '<div class="integration-subtitle">' + esc(p.type) + '</div>' +
        '</div>' +
        '<div class="integration-cell"><span class="badge" data-tone="' + (p.enabled ? 'ok' : 'neutral') + '">' + esc(p.type) + '</span></div>' +
        '<div class="integration-cell muted">' + esc(stLabel) + '</div>' +
        '<div class="integration-quick-actions">' +
          '<button class="toggle' + (p.enabled ? ' on' : '') + '" data-toggle-project-id="' + esc(p.id) + '" title="' + (p.enabled ? 'Disable' : 'Enable') + '"></button>' +
          '<button class="icon-btn" data-edit-project-id="' + esc(p.id) + '" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
          '<button class="icon-btn danger" data-delete-project-id="' + esc(p.id) + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>' +
        '</div>' +
        '<div class="integration-cell">' +
          '<button class="integration-row-expand" data-expand-project-id="' + esc(p.id) + '">' +
            '<span class="integration-row-chevron">' + (isExpanded ? '▲' : '▼') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      (isExpanded ? renderExpandedProjectDetails(p) : '') +
    '</div>'
  );
}

function renderExpandedProjectDetails(p) {
  const stLabel = projectSourceTargetLabel(p);
  return (
    '<div class="integration-row-details" data-project-details-for="' + esc(p.id) + '">' +
      '<div class="integration-row-details-grid">' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title"><strong>Summary</strong></div>' +
          renderSettingRows([
            ['Type', p.type],
            ['Agent', p.agentName || '—'],
            ['Status', p.enabled ? 'Enabled' : 'Disabled'],
            ['Created', fmt(p.createdAt)],
            ['Updated', fmt(p.updatedAt)],
          ]) +
        '</div>' +
        '<div class="integration-row-details-panel">' +
          '<div class="integration-row-details-title"><strong>Source / Target</strong></div>' +
          renderSettingRows([
            ['Source / Target', stLabel],
          ]) +
        '</div>' +
        '<div class="integration-row-details-panel integration-row-details-wide">' +
          '<div class="integration-row-details-title"><strong>Actions</strong></div>' +
          '<div class="integration-row-details-actions">' +
            '<button data-role="project-inline-toggle">' + esc(p.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="primary" data-role="project-inline-edit">Edit Project</button>' +
            '<button class="danger" data-role="project-inline-delete">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function toggleProjectDrawer(projectId) {
  if (!projectId) return;
  if (S.selectedProjectId === projectId) {
    S.projectDrawerOpen = !S.projectDrawerOpen;
  } else {
    S.selectedProjectId = projectId;
    S.projectDrawerOpen = true;
  }
  S.projectDrawerMode = 'view';
  renderProjectsSection();
}

function closeProjectDrawer() {
  S.projectDrawerOpen = false;
  S.projectDrawerMode = 'view';
  renderProjectsSection();
}

function bindProjectActionHandlers(root) {
  root.querySelectorAll('[data-toggle-project-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleProjectStatus(btn.getAttribute('data-toggle-project-id'));
    });
  });
  root.querySelectorAll('[data-edit-project-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void editProject(btn.getAttribute('data-edit-project-id'));
    });
  });
  root.querySelectorAll('[data-delete-project-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteProject(btn.getAttribute('data-delete-project-id'));
    });
  });
  root.querySelectorAll('[data-role="project-inline-toggle"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (S.selectedProjectId) void toggleProjectStatus(S.selectedProjectId);
    });
  });
  root.querySelectorAll('[data-role="project-inline-edit"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (S.selectedProjectId) void editProject(S.selectedProjectId);
    });
  });
  root.querySelectorAll('[data-role="project-inline-delete"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (S.selectedProjectId) void deleteProject(S.selectedProjectId);
    });
  });
}

async function toggleProjectStatus(projectId) {
  try {
    const p = S.projects.find(x => x.id === projectId);
    if (!p) return;
    await adminFetch('/api/admin/projects/' + enc(projectId) + '/' + (p.enabled ? 'disable' : 'enable'), 'PATCH');
    await loadProjects();
    showActionToast(p.enabled ? 'Project disabled' : 'Project enabled', false);
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function editProject(projectId) {
  try {
    const r = await adminFetch('/api/admin/projects/' + enc(projectId));
    showProjectModal(r.project);
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

async function deleteProject(projectId) {
  try {
    if (!confirm('Delete this project?')) return;
    await adminFetch('/api/admin/projects/' + enc(projectId), 'DELETE');
    await loadProjects();
    showActionToast('Project deleted', false);
    S.selectedProjectId = null;
    S.projectDrawerOpen = false;
  } catch (err) {
    showActionToast('Error: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

function showProjectModal(existing) {
  const isEdit = Boolean(existing);
  const initialType = (existing && existing.type) || 'coding';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal" data-role="project-modal">' +
      '<h3>' + (isEdit ? 'Edit Project' : 'New Project') + '</h3>' +
      '<label>Name</label>' +
      '<input data-f="name" value="' + esc((existing && existing.name) || '') + '" />' +
      '<label>Type</label>' +
      '<select data-f="type"' + (isEdit ? ' disabled' : '') + '>' +
        '<option value="coding"' + (initialType === 'coding' ? ' selected' : '') + '>coding</option>' +
        '<option value="review"' + (initialType === 'review' ? ' selected' : '') + '>review</option>' +
      '</select>' +
      '<label>Agent</label>' +
      '<select data-f="agentId"></select>' +
      '<label>Post-Clone Script (coding only)</label>' +
      '<textarea class="post-clone-input" data-f="postCloneScript" rows="1" placeholder="optional bash script">' + esc((existing && existing.postCloneScript) || '') + '</textarea>' +
      '<div data-role="ticketsource-section"></div>' +
      '<div data-role="pushtargets-section"></div>' +
      '<div data-role="reviewtarget-section"></div>' +
      '<div data-role="modal-error" style="color:var(--danger);font-size:12px;margin-top:6px"></div>' +
      '<div class="modal-actions">' +
        '<button data-role="cancel">Cancel</button>' +
        '<button class="primary" data-role="save">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  const typeSel = overlay.querySelector('[data-f="type"]');
  const agentSel = overlay.querySelector('[data-f="agentId"]');
  const tsSection = overlay.querySelector('[data-role="ticketsource-section"]');
  const ptSection = overlay.querySelector('[data-role="pushtargets-section"]');
  const rtSection = overlay.querySelector('[data-role="reviewtarget-section"]');
  const errorBox = overlay.querySelector('[data-role="modal-error"]');

  function refreshAgentDropdown() {
    const t = typeSel.value;
    const matchingAgents = S.agents.filter((a) => a.type === t);
    agentSel.innerHTML = matchingAgents.length === 0
      ? '<option value="">— no ' + t + ' agents —</option>'
      : matchingAgents.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
    if (existing && existing.agentId) agentSel.value = existing.agentId;
    const hintId = 'agent-hint-' + t;
    const existingHint = overlay.querySelector('#' + hintId);
    if (existingHint) existingHint.remove();
    if (matchingAgents.length === 0) {
      const hint = document.createElement('div');
      hint.id = hintId;
      hint.style.cssText = 'color:var(--warning,#b85c00);font-size:12px;margin-top:4px';
      hint.textContent = 'No ' + t + ' agent configured. Open the Agents tab to create and enable one before saving.';
      agentSel.insertAdjacentElement('afterend', hint);
    }
  }

  function ticketIntegrationOptions() {
    return S.integrations
      .filter((i) => integrationSupportsCapability(i, 'ticketing'))
      .map((i) => '<option value="' + esc(i.id) + '">' + esc(i.name) + ' (' + esc(i.type) + ')</option>').join('');
  }
  function vcsIntegrationOptions() {
    return S.integrations
      .filter((i) => integrationSupportsCapability(i, 'vcs'))
      .map((i) => '<option value="' + esc(i.id) + '">' + esc(i.name) + ' (' + esc(i.type) + ')</option>').join('');
  }
  function reviewIntegrationOptions() {
    return S.integrations
      .filter((i) => integrationSupportsCapability(i, 'review'))
      .map((i) => '<option value="' + esc(i.id) + '">' + esc(i.name) + ' (' + esc(i.type) + ')</option>').join('');
  }

  async function ensureDiscovered(integrationId) {
    if (!integrationId) return;
    const integ = S.integrations.find((i) => i.id === integrationId);
    if (!integ || !integ.discoverySupported) return;
    if (integ.discoveredResources && (integ.discoveredResources.ticketProjects || integ.discoveredResources.repositories)) return;
    try {
      await adminFetch('/api/admin/integrations/' + enc(integrationId) + '/discover', 'POST');
      await loadIntegrations();
    } catch { /* discovery is best-effort */ }
  }

  function ticketProjectOptions(integrationId, search) {
    const integ = S.integrations.find((i) => i.id === integrationId);
    if (!integ || !integ.discoveredResources || !integ.discoveredResources.ticketProjects) {
      return '<option value="">— refresh integration first —</option>';
    }
    const q = String(search || '').trim().toLowerCase();
    const items = integ.discoveredResources.ticketProjects
      .filter((p) => !q || String(p.key).toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q))
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
    if (items.length === 0) {
      return '<option value="">— no projects match —</option>';
    }
    return items.map((p) => '<option value="' + esc(p.key) + '">' + esc(p.key) + ' — ' + esc(p.name) + '</option>').join('');
  }
  function repoOptions(integrationId, search) {
    const integ = S.integrations.find((i) => i.id === integrationId);
    if (!integ || !integ.discoveredResources || !integ.discoveredResources.repositories) {
      return '<option value="">— refresh integration first —</option>';
    }
    const q = String(search || '').trim().toLowerCase();
    const items = integ.discoveredResources.repositories
      .filter((r) => !q || String(r.key).toLowerCase().includes(q))
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
    if (items.length === 0) {
      return '<option value="">— no repos match —</option>';
    }
    return items.map((r) => '<option value="' + esc(r.key) + '" data-clone="' + esc(r.cloneUrlSsh || r.cloneUrlHttp || '') + '" data-branch="' + esc(r.defaultBranch || 'main') + '">' + esc(r.key) + '</option>').join('');
  }

  let pushTargets = (existing && existing.type === 'coding' && existing.pushTargets) ? existing.pushTargets.map((p) => ({
    integrationId: p.integrationId, repoKey: p.repoKey, cloneUrl: p.cloneUrl, targetBranch: p.targetBranch,
    role: p.role, commitOrder: p.commitOrder, localPath: p.localPath, sshKeyPath: p.sshKeyPath ?? '',
  })) : [];
  const pushTargetSearch = [];
  let ticketProjectSearch = '';
  let reviewRepoSearch = '';
  let reviewSelectedRepos = (existing && existing.reviewConfig && existing.reviewConfig.repos)
    ? existing.reviewConfig.repos.slice()
    : null;

  function renderPushTargetsSection() {
    if (typeSel.value !== 'coding') { ptSection.innerHTML = ''; return; }
    const integOpts = vcsIntegrationOptions();
    const rows = pushTargets.map((pt, idx) => {
      const search = pushTargetSearch[idx] || '';
      const repoOpts = repoOptions(pt.integrationId, search);
      return '<div class="pt-row" data-idx="' + idx + '" style="border:1px solid var(--border);padding:6px;margin-top:4px">' +
        '<label>Integration</label>' +
        '<select data-pf="integrationId">' + integOpts + '</select>' +
        '<label>Repo</label>' +
        '<input type="search" data-pf-search="repoKey" placeholder="Search repositories…" value="' + esc(search) + '" style="width:100%;margin-bottom:4px" />' +
        '<select data-pf="repoKey">' + repoOpts + '</select>' +
        '<label>Clone URL</label>' +
        '<input data-pf="cloneUrl" value="' + esc(pt.cloneUrl) + '" />' +
        '<label>Target branch</label>' +
        '<input data-pf="targetBranch" value="' + esc(pt.targetBranch) + '" />' +
        '<label>Role</label>' +
        '<select data-pf="role">' +
          ['primary','submodule','dependency','related'].map((r) => '<option value="' + r + '"' + (pt.role === r ? ' selected' : '') + '>' + r + '</option>').join('') +
        '</select>' +
        '<label>Commit order</label>' +
        '<input type="number" min="1" data-pf="commitOrder" value="' + String(pt.commitOrder) + '" />' +
        '<label>Local path</label>' +
        '<input data-pf="localPath" value="' + esc(pt.localPath) + '" />' +
        '<label>SSH key path</label>' +
        '<input data-pf="sshKeyPath" placeholder="/app/secrets/id_ed25519" value="' + esc(pt.sshKeyPath || '') + '" />' +
        '<div style="margin-top:4px">' +
          '<button data-pa="up">↑</button> <button data-pa="down">↓</button> <button data-pa="remove">Remove</button>' +
        '</div>' +
      '</div>';
    }).join('');
    ptSection.innerHTML =
      '<h4>Repositories</h4>' + rows +
      '<button data-role="add-pt" style="margin-top:6px">+ Add repository</button>';

    ptSection.querySelectorAll('.pt-row').forEach((row) => {
      const idx = Number(row.getAttribute('data-idx'));
      const integSel = row.querySelector('[data-pf="integrationId"]');
      if (integSel) {
        integSel.value = pushTargets[idx].integrationId || '';
        integSel.addEventListener('change', async () => {
          pushTargets[idx].integrationId = integSel.value;
          pushTargetSearch[idx] = '';
          await ensureDiscovered(integSel.value);
          renderPushTargetsSection();
        });
      }
      const searchInp = row.querySelector('[data-pf-search="repoKey"]');
      if (searchInp) {
        searchInp.addEventListener('input', () => {
          pushTargetSearch[idx] = searchInp.value;
          const repoSel2 = row.querySelector('[data-pf="repoKey"]');
          if (repoSel2) {
            const current = pushTargets[idx].repoKey || '';
            repoSel2.innerHTML = repoOptions(pushTargets[idx].integrationId, searchInp.value);
            if (current && Array.from(repoSel2.options).some((o) => o.value === current)) {
              repoSel2.value = current;
            }
          }
        });
      }
      const repoSel = row.querySelector('[data-pf="repoKey"]');
      if (repoSel) {
        repoSel.value = pushTargets[idx].repoKey || '';
        repoSel.addEventListener('change', () => {
          pushTargets[idx].repoKey = repoSel.value;
          const opt = repoSel.selectedOptions[0];
          if (opt) {
            const cloneUrl = opt.getAttribute('data-clone') || pushTargets[idx].cloneUrl;
            const branch = opt.getAttribute('data-branch') || pushTargets[idx].targetBranch;
            pushTargets[idx].cloneUrl = cloneUrl;
            pushTargets[idx].targetBranch = branch || pushTargets[idx].targetBranch || 'main';
            renderPushTargetsSection();
          }
        });
      }
      ['cloneUrl','targetBranch','localPath','sshKeyPath'].forEach((k) => {
        const inp = row.querySelector('[data-pf="' + k + '"]');
        if (inp) inp.addEventListener('input', () => { pushTargets[idx][k] = inp.value; });
      });
      const roleSel = row.querySelector('[data-pf="role"]');
      if (roleSel) roleSel.addEventListener('change', () => { pushTargets[idx].role = roleSel.value; });
      const orderInp = row.querySelector('[data-pf="commitOrder"]');
      if (orderInp) orderInp.addEventListener('input', () => { pushTargets[idx].commitOrder = Number(orderInp.value) || 1; });
      row.querySelector('[data-pa="remove"]').addEventListener('click', () => {
        pushTargets.splice(idx, 1);
        pushTargetSearch.splice(idx, 1);
        pushTargets.forEach((pt, i) => { pt.commitOrder = i + 1; });
        renderPushTargetsSection();
      });
      row.querySelector('[data-pa="up"]').addEventListener('click', () => {
        if (idx === 0) return;
        const [moved] = pushTargets.splice(idx, 1);
        pushTargets.splice(idx - 1, 0, moved);
        const [movedSearch] = pushTargetSearch.splice(idx, 1);
        pushTargetSearch.splice(idx - 1, 0, movedSearch || '');
        pushTargets.forEach((pt, i) => { pt.commitOrder = i + 1; });
        renderPushTargetsSection();
      });
      row.querySelector('[data-pa="down"]').addEventListener('click', () => {
        if (idx >= pushTargets.length - 1) return;
        const [moved] = pushTargets.splice(idx, 1);
        pushTargets.splice(idx + 1, 0, moved);
        const [movedSearch] = pushTargetSearch.splice(idx, 1);
        pushTargetSearch.splice(idx + 1, 0, movedSearch || '');
        pushTargets.forEach((pt, i) => { pt.commitOrder = i + 1; });
        renderPushTargetsSection();
      });
    });
    const addBtn = ptSection.querySelector('[data-role="add-pt"]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        pushTargets.push({ integrationId: '', repoKey: '', cloneUrl: '', targetBranch: 'main', role: 'primary', commitOrder: pushTargets.length + 1, localPath: '.', sshKeyPath: '' });
        pushTargetSearch.push('');
        renderPushTargetsSection();
      });
    }
  }

  function renderTicketSourceSection() {
    if (typeSel.value !== 'coding') { tsSection.innerHTML = ''; return; }
    const ts = (existing && existing.ticketSource) || {};
    const integOpts = ticketIntegrationOptions();
    const integId = (ts.integration && ts.integration.id) || '';
    tsSection.innerHTML =
      '<h4>Ticket Source</h4>' +
      '<label>Integration</label>' +
      '<select data-tsf="integrationId">' + integOpts + '</select>' +
      '<label>Project</label>' +
      '<input type="search" data-tsf-search="ticketProjectKey" placeholder="Search projects…" value="' + esc(ticketProjectSearch) + '" style="width:100%;margin-bottom:4px" />' +
      '<select data-tsf="ticketProjectKey">' + ticketProjectOptions(integId, ticketProjectSearch) + '</select>';
    const integSel = tsSection.querySelector('[data-tsf="integrationId"]');
    integSel.value = integId;
    integSel.addEventListener('change', async () => {
      const newId = integSel.value;
      await ensureDiscovered(newId);
      const projSel = tsSection.querySelector('[data-tsf="ticketProjectKey"]');
      projSel.innerHTML = ticketProjectOptions(newId, ticketProjectSearch);
    });
    const searchInp = tsSection.querySelector('[data-tsf-search="ticketProjectKey"]');
    searchInp.addEventListener('input', () => {
      ticketProjectSearch = searchInp.value;
      const projSel = tsSection.querySelector('[data-tsf="ticketProjectKey"]');
      const current = projSel.value;
      projSel.innerHTML = ticketProjectOptions(integSel.value, ticketProjectSearch);
      if (current && Array.from(projSel.options).some((o) => o.value === current)) {
        projSel.value = current;
      }
    });
    const projSel = tsSection.querySelector('[data-tsf="ticketProjectKey"]');
    if (ts.ticketProjectKey) projSel.value = ts.ticketProjectKey;
  }

  function renderReviewTargetSection() {
    if (typeSel.value !== 'review') { rtSection.innerHTML = ''; return; }
    const rc = (existing && existing.reviewConfig) || {};
    const integOpts = reviewIntegrationOptions();
    const integId = (rc.integration && rc.integration.id) || '';

    function ensureSelections(integrationId) {
      const integ = S.integrations.find((i) => i.id === integrationId);
      const repos = (integ && integ.discoveredResources && integ.discoveredResources.repositories) || [];
      if (reviewSelectedRepos === null) {
        reviewSelectedRepos = repos.map((r) => r.key);
      }
    }
    ensureSelections(integId);

    function repoCheckboxes(integrationId) {
      const integ = S.integrations.find((i) => i.id === integrationId);
      if (!integ || !integ.discoveredResources || !integ.discoveredResources.repositories) {
        return '<div style="color:var(--muted);font-size:12px">No repositories found — refresh integration first.</div>';
      }
      const q = String(reviewRepoSearch || '').trim().toLowerCase();
      const items = integ.discoveredResources.repositories
        .filter((r) => !q || String(r.key).toLowerCase().includes(q))
        .slice()
        .sort((a, b) => String(a.key).localeCompare(String(b.key)));
      if (items.length === 0) {
        return '<div style="color:var(--muted);font-size:12px">No repositories match.</div>';
      }
      return items.map((r) => {
        const checked = (reviewSelectedRepos || []).includes(r.key) ? ' checked' : '';
        return '<label style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
          '<input type="checkbox" class="rc-repo-check" value="' + esc(r.key) + '"' + checked + ' />' +
          '<span>' + esc(r.key) + '</span>' +
        '</label>';
      }).join('');
    }

    rtSection.innerHTML =
      '<h4>Review Configuration</h4>' +
      '<label>Integration</label>' +
      '<select data-rtf="integrationId">' + integOpts + '</select>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;margin-bottom:4px">' +
        '<label style="margin:0">Repositories (all pre-selected)</label>' +
        '<div style="display:flex;gap:4px">' +
          '<button type="button" data-role="rc-select-all" style="font-size:11px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer">Select all</button>' +
          '<button type="button" data-role="rc-unselect-all" style="font-size:11px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer">Unselect all</button>' +
        '</div>' +
      '</div>' +
      '<input type="search" data-rtf-search="repos" placeholder="Search repositories…" value="' + esc(reviewRepoSearch) + '" style="width:100%;margin-bottom:4px" />' +
      '<div data-role="rc-repos">' + repoCheckboxes(integId) + '</div>';
    const integSel = rtSection.querySelector('[data-rtf="integrationId"]');
    integSel.value = integId;

    function persistSelections() {
      if (reviewSelectedRepos === null) reviewSelectedRepos = [];
      rtSection.querySelectorAll('.rc-repo-check').forEach((cb) => {
        const key = cb.value;
        const i = reviewSelectedRepos.indexOf(key);
        if (cb.checked && i === -1) reviewSelectedRepos.push(key);
        if (!cb.checked && i !== -1) reviewSelectedRepos.splice(i, 1);
      });
    }

    function bindSelectButtons() {
      const selectBtn = rtSection.querySelector('[data-role="rc-select-all"]');
      const unselectBtn = rtSection.querySelector('[data-role="rc-unselect-all"]');
      if (selectBtn) {
        selectBtn.addEventListener('click', () => {
          const integ = S.integrations.find((i) => i.id === integSel.value);
          const allKeys = (integ && integ.discoveredResources && integ.discoveredResources.repositories || []).map((r) => r.key);
          reviewSelectedRepos = allKeys.slice();
          rtSection.querySelectorAll('.rc-repo-check').forEach((b) => { b.checked = true; });
        });
      }
      if (unselectBtn) {
        unselectBtn.addEventListener('click', () => {
          reviewSelectedRepos = [];
          rtSection.querySelectorAll('.rc-repo-check').forEach((b) => { b.checked = false; });
        });
      }
      rtSection.querySelectorAll('.rc-repo-check').forEach((cb) => {
        cb.addEventListener('change', persistSelections);
      });
    }
    bindSelectButtons();

    const searchInp = rtSection.querySelector('[data-rtf-search="repos"]');
    searchInp.addEventListener('input', () => {
      persistSelections();
      reviewRepoSearch = searchInp.value;
      rtSection.querySelector('[data-role="rc-repos"]').innerHTML = repoCheckboxes(integSel.value);
      bindSelectButtons();
    });

    integSel.addEventListener('change', async () => {
      const newId = integSel.value;
      reviewSelectedRepos = null;
      await ensureDiscovered(newId);
      ensureSelections(newId);
      rtSection.querySelector('[data-role="rc-repos"]').innerHTML = repoCheckboxes(newId);
      bindSelectButtons();
    });
  }

  refreshAgentDropdown();
  renderTicketSourceSection();
  renderPushTargetsSection();
  renderReviewTargetSection();

  typeSel.addEventListener('change', () => {
    refreshAgentDropdown();
    renderTicketSourceSection();
    renderPushTargetsSection();
    renderReviewTargetSection();
  });

  overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-role="save"]').addEventListener('click', async () => {
    errorBox.textContent = '';
    const get = (k) => {
      const node = overlay.querySelector('[data-f="' + k + '"]');
      if (!node) return undefined;
      if (node.type === 'checkbox') return node.checked;
      return node.value;
    };
    const t = typeSel.value;
    const payload = {
      name: get('name'),
      type: t,
      agentId: agentSel.value,
      postCloneScript: get('postCloneScript') || '',
    };
    if (t === 'coding') {
      const tsInteg = tsSection.querySelector('[data-tsf="integrationId"]').value;
      const tsKey = tsSection.querySelector('[data-tsf="ticketProjectKey"]').value;
      payload.ticketSource = { integrationId: tsInteg, ticketProjectKey: tsKey };
      payload.pushTargets = pushTargets.map((pt) => ({
        integrationId: pt.integrationId,
        repoKey: pt.repoKey,
        cloneUrl: pt.cloneUrl,
        targetBranch: pt.targetBranch,
        role: pt.role,
        commitOrder: pt.commitOrder,
        localPath: pt.localPath,
        ...(pt.sshKeyPath ? { sshKeyPath: pt.sshKeyPath } : {}),
      }));
    } else {
      const rtInteg = rtSection.querySelector('[data-rtf="integrationId"]').value;
      const visible = Array.from(rtSection.querySelectorAll('.rc-repo-check'));
      if (reviewSelectedRepos === null) reviewSelectedRepos = [];
      visible.forEach((cb) => {
        const key = cb.value;
        const i = reviewSelectedRepos.indexOf(key);
        if (cb.checked && i === -1) reviewSelectedRepos.push(key);
        if (!cb.checked && i !== -1) reviewSelectedRepos.splice(i, 1);
      });
      payload.reviewConfig = { integrationId: rtInteg, repoKeys: reviewSelectedRepos.slice() };
    }
    try {
      if (isEdit) {
        delete payload.type;
        await adminFetch('/api/admin/projects/' + enc(existing.id), 'PUT', JSON.stringify(payload));
      } else {
        await adminFetch('/api/admin/projects', 'POST', JSON.stringify(payload));
      }
      overlay.remove();
      await loadProjects();
      showActionToast(isEdit ? 'Project updated' : 'Project created', false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorBox.textContent = msg;
    }
  });
}

async function refreshIntegrationDiscovery(integrationId) {
  try {
    showActionToast('Refreshing resources...', false);
    await adminFetch('/api/admin/integrations/' + enc(integrationId) + '/discover', 'POST');
    await loadIntegrations();
    showActionToast('Resources refreshed', false);
  } catch (err) {
    showActionToast('Discovery failed: ' + (err instanceof Error ? err.message : 'Unknown'), true);
  }
}

// ── Escape key: close configuration modals with save confirmation ──
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  // Don't interfere if an escape-confirm dialog is already showing
  if (document.querySelector('.escape-confirm-overlay')) return;
  const overlay = document.querySelector('.modal-overlay');
  if (!overlay) return;
  e.preventDefault();
  e.stopPropagation();

  const confirmOverlay = document.createElement('div');
  confirmOverlay.className = 'escape-confirm-overlay';
  confirmOverlay.innerHTML =
    '<div class="escape-confirm-dialog">' +
      '<h4>Unsaved Changes</h4>' +
      '<p>Do you want to save your changes before closing?</p>' +
      '<div class="escape-confirm-actions">' +
        '<button data-role="esc-cancel">Cancel</button>' +
        '<button data-role="esc-discard" style="color:var(--danger)">Discard</button>' +
        '<button class="primary" data-role="esc-save">Save</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(confirmOverlay);

  confirmOverlay.querySelector('[data-role="esc-cancel"]').addEventListener('click', function() {
    confirmOverlay.remove();
  });
  confirmOverlay.querySelector('[data-role="esc-discard"]').addEventListener('click', function() {
    confirmOverlay.remove();
    overlay.remove();
  });
  confirmOverlay.querySelector('[data-role="esc-save"]').addEventListener('click', function() {
    confirmOverlay.remove();
    var saveBtn = overlay.querySelector('[data-role="modal-save"]') || overlay.querySelector('[data-role="save"]');
    if (saveBtn) saveBtn.click();
  });
  // Close confirmation when clicking outside the dialog
  confirmOverlay.addEventListener('click', function(ev) {
    if (ev.target === confirmOverlay) confirmOverlay.remove();
  });
});
`;

/** Render the full admin dashboard HTML page with bootstrapped runtime config. */
export function renderAdminDashboardHtml(options?: {
  requiresAuth?: boolean | undefined;
  authMode?: "none" | "bearer" | "hmac" | "mixed" | undefined;
  gerritBaseUrl?: string | undefined;
  gitlabBaseUrl?: string | undefined;
  ticketLinkTemplates?: Record<string, string> | undefined;
  nonce?: string | undefined;
}): string {
  // ⚠️ SECURITY: Escape HTML special characters in bootstrap JSON to prevent XSS.
  // JSON embedded in <script> tags must be carefully escaped to avoid breaking out of the string context.
  // For example, if bootstrap contained "</script>", the browser would close the script tag prematurely,
  // allowing arbitrary JavaScript to execute. Similarly, "/" starts a regex comment.
  // We use Unicode escapes (\u003c, \u003e, \u0026) which are interpreted the same in JSON but
  // cannot break the JSON string or script tag context.
  // Note: We escape AFTER JSON.stringify to avoid double-escaping and to ensure the result is still valid JSON.
  const bootstrap = JSON.stringify({
    requiresAuth: options?.requiresAuth ?? false,
    authMode: options?.authMode ?? "none",
    gerritBaseUrl: options?.gerritBaseUrl ?? null,
    gitlabBaseUrl: options?.gitlabBaseUrl ?? null,
    ticketLinkTemplates: options?.ticketLinkTemplates ?? {},
  })
    .replace(/</g, "\\u003c")    // < → \u003c (prevents </ closing tags)
    .replace(/>/g, "\\u003e")    // > → \u003e (symmetry)
    .replace(/&/g, "\\u0026");   // & → \u0026 (prevents HTML entity confusion)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Virtual Engineer — Admin</title>
    <link rel="stylesheet" href="/assets/dashboard.css" />
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <span class="brand">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          Virtual Engineer
        </span>
        <div class="topbar-status" data-role="status-bar"></div>
        <div class="topbar-actions">
          <span style="font-size:12px;color:var(--muted)" data-role="auth-status"></span>
          <button type="button" class="icon-btn" data-role="logout" title="Log out"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>
        </div>
      </header>
      <nav class="nav-bar">
        <button class="nav-tab active" data-nav="tasks">Tasks</button>
        <button class="nav-tab" data-nav="configuration">Configuration</button>
      </nav>
      <div class="page-content">
        <div class="page-view active" data-view="tasks">
          <div class="workspace">
            <aside class="sidebar">
              <div data-role="auth"></div>
              <div class="auth-error" data-role="auth-error"></div>
              <section class="section">
                <div class="section-head-row">
                  <div class="section-head">Tasks</div>
                  <div class="tasks-filter-icons">
                    <button class="tasks-filter-btn" id="filt-all">All</button>
                    <button class="tasks-filter-btn" id="filt-run" title="Agent Running">⚙</button>
                    <button class="tasks-filter-btn" id="filt-rev" title="In Review">👁</button>
                    <button class="tasks-filter-btn" id="filt-done" title="Done">✓</button>
                    <button class="tasks-filter-btn" id="filt-fail" title="Failed">✕</button>
                    <button class="tasks-filter-btn" id="filt-review" title="Code Reviews">📝</button>
                    <div class="tasks-filter-divider"></div>
                    <button class="tasks-sort-btn" id="sort-dir" title="Sort by last updated">↕</button>
                  </div>
                </div>
                <div data-role="tasks"></div>
              </section>
            </aside>
            <main class="detail" data-role="task-detail">
              <div class="empty-state">Select a task to inspect its cycles and transition timeline.</div>
            </main>
          </div>
        </div>
        <div class="page-view" data-view="configuration">
          <div class="configuration-shell" data-role="configuration-shell">
            <aside class="configuration-nav" data-role="configuration-nav"></aside>
            <section class="configuration-main" data-role="configuration-main">
              <div class="configuration-header" data-role="configuration-header"></div>
              <div class="configuration-toolbar" data-role="configuration-toolbar"></div>
              <div class="configuration-content" data-role="configuration-content"></div>
            </section>
          </div>
        </div>
      </div>
    </div>
    <script nonce="${options?.nonce ?? ''}">window.__VE_ADMIN_BOOTSTRAP__ = ${bootstrap};</script>
    <script nonce="${options?.nonce ?? ''}">${script}</script>
  </body>
</html>`;
}
