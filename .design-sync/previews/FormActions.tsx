import React from "react";
import { FormActions } from "virtual-engineer";

export function SaveCancel() {
  return (
    <div style={{ padding: 24, maxWidth: 400 }}>
      <FormActions>
        <button className="btn">Cancel</button>
        <button className="btn primary">Save Integration</button>
      </FormActions>
    </div>
  );
}

export function WithDanger() {
  return (
    <div style={{ padding: 24, maxWidth: 400 }}>
      <FormActions>
        <button className="btn danger">Delete</button>
        <span style={{ flex: 1 }} />
        <button className="btn">Cancel</button>
        <button className="btn primary">Confirm</button>
      </FormActions>
    </div>
  );
}

export function Loading() {
  return (
    <div style={{ padding: 24, maxWidth: 400 }}>
      <FormActions>
        <button className="btn">Cancel</button>
        <button className="btn primary" disabled style={{ opacity: 0.7 }}>
          Connecting…
        </button>
      </FormActions>
    </div>
  );
}
