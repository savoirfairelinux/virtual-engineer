import React from "react";
import { FormRow, Field, FieldInput, FieldSelect, FormError } from "virtual-engineer";

export function IntegrationForm() {
  return (
    <div style={{ padding: 24, maxWidth: 420 }}>
      <FormRow>
        <Field label="Name" required>
          <FieldInput placeholder="My GitHub Repo" />
        </Field>
        <Field label="Provider">
          <FieldSelect>
            <option>GitHub</option>
            <option>GitLab</option>
            <option>Gerrit</option>
          </FieldSelect>
        </Field>
        <Field label="Repository URL" required hint="HTTPS clone URL">
          <FieldInput placeholder="https://github.com/owner/repo" />
        </Field>
        <Field label="Branch">
          <FieldInput placeholder="main" />
        </Field>
      </FormRow>
    </div>
  );
}

export function WithError() {
  return (
    <div style={{ padding: 24, maxWidth: 420 }}>
      <FormRow>
        <FormError msg="Could not connect to the repository. Check the URL and your access token." />
        <Field label="Repository URL" required>
          <FieldInput
            placeholder="https://github.com/owner/repo"
            defaultValue="https://github.com/bad/url"
            style={{ borderColor: "var(--danger)" }}
          />
        </Field>
      </FormRow>
    </div>
  );
}
