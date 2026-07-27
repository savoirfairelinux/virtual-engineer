import React from "react";
import { Field, FieldInput, FieldSelect, FieldTextarea } from "virtual-engineer";

export function TextInput() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 400 }}>
      <Field label="Repository URL" required hint="The HTTPS URL of the repository to monitor.">
        <FieldInput placeholder="https://github.com/owner/repo" />
      </Field>
      <Field label="Branch" required>
        <FieldInput placeholder="main" defaultValue="main" />
      </Field>
    </div>
  );
}

export function SelectAndTextarea() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 400 }}>
      <Field label="Provider">
        <FieldSelect>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="gerrit">Gerrit</option>
        </FieldSelect>
      </Field>
      <Field label="Agent prompt" hint="Instructions passed to the coding agent.">
        <FieldTextarea
          rows={4}
          placeholder="You are a coding assistant. When a task is detected…"
        />
      </Field>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 400 }}>
      <Field label="Project ID">
        <FieldInput value="proj_a1b2c3d4" disabled />
      </Field>
      <Field label="Status">
        <FieldSelect disabled>
          <option>Active</option>
        </FieldSelect>
      </Field>
    </div>
  );
}
