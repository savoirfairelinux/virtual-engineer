import React from "react";
import { DetailSection, DetailRow } from "virtual-engineer";

export function TaskDetails() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <DetailSection label="Ticket">
        <DetailRow k="Source">GitHub Issue #128</DetailRow>
        <DetailRow k="Title">Fix auth session timeout on mobile</DetailRow>
        <DetailRow k="Assignee">Fadi Shehadeh</DetailRow>
        <DetailRow k="Created">2 hours ago</DetailRow>
      </DetailSection>

      <DetailSection label="Work">
        <DetailRow k="Branch" mono>fix/auth-session-mobile</DetailRow>
        <DetailRow k="Commit" mono>a29c08e</DetailRow>
        <DetailRow k="PR">#142 — Fix mobile auth session</DetailRow>
      </DetailSection>
    </div>
  );
}

export function MinimalSection() {
  return (
    <div style={{ padding: 24 }}>
      <DetailSection>
        <DetailRow k="Status">Running</DetailRow>
        <DetailRow k="Duration">3m 42s</DetailRow>
        <DetailRow k="Agent">Claude Sonnet 4</DetailRow>
      </DetailSection>
    </div>
  );
}
