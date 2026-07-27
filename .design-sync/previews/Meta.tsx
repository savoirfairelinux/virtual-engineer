import React from "react";
import { Meta } from "virtual-engineer";

export function Variants() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 10 }}>
      <Meta label="Repository">virtual-engineer / main</Meta>
      <Meta label="Provider">GitHub</Meta>
      <Meta label="Commit" mono>a29c08e3</Meta>
      <Meta label="Status" accent>Active</Meta>
    </div>
  );
}

export function Card() {
  return (
    <div className="card" style={{ padding: 16, margin: 24, display: "flex", flexDirection: "column", gap: 8 }}>
      <Meta label="Project">virtual-engineer</Meta>
      <Meta label="Branch" mono>feat/webhook-events</Meta>
      <Meta label="Author">Fadi Shehadeh</Meta>
      <Meta label="Updated">2 minutes ago</Meta>
    </div>
  );
}
