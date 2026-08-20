import React from "react";
import { GuidedTour } from "virtual-engineer";

const navBarStyle: React.CSSProperties = {
  display: "flex", gap: 4, padding: "10px 14px", background: "var(--panel)",
  borderBottom: "1px solid var(--border)", alignItems: "center",
};

const navBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px",
  borderRadius: 8, fontSize: 13, fontWeight: 600, color: "var(--text-dim)",
  background: "none", border: "none", cursor: "pointer",
};

export function MainNav() {
  return (
    <div style={{ height: 260, position: "relative" }}>
      <div style={navBarStyle}>
        <button style={navBtnStyle} data-tour="nav-overview">Overview</button>
        <button style={navBtnStyle} data-tour="nav-tasks">Tasks</button>
        <button style={navBtnStyle} data-tour="nav-config">Configuration</button>
      </div>
      <GuidedTour
        tourKey="preview-main-nav"
        enabled
        steps={[
          {
            target: '[data-tour="nav-overview"]',
            title: "Overview",
            body: "Your dashboard: task activity, throughput, AI cost, and system health at a glance.",
            placement: "bottom",
          },
          {
            target: '[data-tour="nav-tasks"]',
            title: "Tasks",
            body: "Every ticket and review VE is working on, with live progress and agent logs.",
            placement: "bottom",
          },
          {
            target: '[data-tour="nav-config"]',
            title: "Configuration",
            body: "Set up integrations, agents, and projects here.",
            placement: "bottom",
          },
        ]}
      />
    </div>
  );
}

export function ConfigWorkflow() {
  return (
    <div style={{ height: 260, display: "flex" }}>
      <div style={{ width: 200, padding: "14px 10px", background: "var(--panel)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
        <button style={{ ...navBtnStyle, justifyContent: "flex-start" }} data-tour="config-nav-integrations">Integrations</button>
        <button style={{ ...navBtnStyle, justifyContent: "flex-start" }} data-tour="config-nav-agents">Agents</button>
        <button style={{ ...navBtnStyle, justifyContent: "flex-start" }} data-tour="config-nav-projects">Projects</button>
      </div>
      <GuidedTour
        tourKey="preview-config-workflow"
        enabled
        steps={[
          {
            target: '[data-tour="config-nav-integrations"]',
            title: "Integrations first",
            body: "Connect the ticket, source-control, review, and agent providers VE will use.",
            placement: "right",
          },
          {
            target: '[data-tour="config-nav-agents"]',
            title: "Agents library",
            body: "Create a reusable coding or review agent with its model, prompts, and execution settings.",
            placement: "right",
          },
          {
            target: '[data-tour="config-nav-projects"]',
            title: "Projects",
            body: "Once your integrations and agent are ready, create a project that connects them to a real workflow.",
            placement: "right",
          },
        ]}
      />
    </div>
  );
}
