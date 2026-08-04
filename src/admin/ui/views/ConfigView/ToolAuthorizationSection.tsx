/**
 * Per-agent tool authorization section for the agent form.
 *
 * Renders provider-specific controls (blocklist-only model — everything is
 * allowed by default):
 * - Claude/Copilot: blockedTools as a checklist of known tools plus a small
 *   free-text field for custom patterns (Bash(prefix:*), mcp__server__tool).
 * - Aider: capability toggles (suggestShellCommands, detectUrls, playwright,
 *   git).
 * - Goose: developerExtension toggle.
 *
 * The section is hidden for providers that don't support tool authorization
 * (mock, or provider not yet resolved).
 */
import { Field, FieldSelect, FieldTextarea } from "../../components/Modal.tsx";
import {
  getToolCatalog,
  supportsToolAuthorization,
  type ToolAuthorizationSectionProps,
  type ToolAuthorizationState,
} from "./toolAuthorizationHelpers.ts";

export function ToolAuthorizationSection({ state, onChange, provider }: ToolAuthorizationSectionProps) {
  if (!supportsToolAuthorization(provider)) return null;

  const update = (patch: Partial<ToolAuthorizationState>) => onChange({ ...state, ...patch });

  const toggleListMember = (value: string, checked: boolean) => {
    const current = state.blockedTools;
    const next = checked ? [...current, value] : current.filter((v) => v !== value);
    update({ blockedTools: next });
  };

  const catalog = getToolCatalog(provider);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", borderTop: "1px solid var(--border, #333)", paddingTop: "14px" }}>
      <strong style={{ fontSize: "13px" }}>Tool authorization</strong>

      {(provider === "claude" || provider === "copilot") && (
        <>
          <Field label="Blocked tools" hint="Everything is allowed by default. Tools checked here are always denied. Merges with VE's network floor (tighten-only).">
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}>
              {catalog.map((tool) => (
                <label key={tool.value} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={state.blockedTools.includes(tool.value)}
                    onChange={(e) => toggleListMember(tool.value, e.currentTarget.checked)}
                  />
                  <span className="mono" style={{ color: "var(--text-dim)" }}>{tool.label}</span>
                  {tool.hint && <span style={{ color: "var(--text-faint)", fontSize: "11px" }}>— {tool.hint}</span>}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Blocked tools — custom patterns" hint="One per line. For scoped rules not in the list above: Bash(rm:*), Bash(git push:*), mcp__server__tool, etc.">
            <FieldTextarea
              value={state.blockedToolsCustom}
              placeholder={"Bash(rm:*)\nBash(curl:*)"}
              rows={3}
              onChange={(e) => update({ blockedToolsCustom: e.currentTarget.value })}
            />
          </Field>
        </>
      )}

      {provider === "aider" && (
        <>
          <Field label="Suggest shell commands" hint="When on, Aider may suggest shell commands to the LLM.">
            <FieldSelect
              value={state.suggestShellCommands ? "true" : "false"}
              onChange={(e) => update({ suggestShellCommands: e.currentTarget.value === "true" })}
            >
              <option value="false">Disabled (default)</option>
              <option value="true">Enabled</option>
            </FieldSelect>
          </Field>
          <Field label="Detect URLs" hint="When on, Aider detects and offers to fetch URLs in chat.">
            <FieldSelect
              value={state.detectUrls ? "true" : "false"}
              onChange={(e) => update({ detectUrls: e.currentTarget.value === "true" })}
            >
              <option value="false">Disabled (default)</option>
              <option value="true">Enabled</option>
            </FieldSelect>
          </Field>
          <Field label="Playwright" hint="When on, Aider may use Playwright for web scraping.">
            <FieldSelect
              value={state.playwright ? "true" : "false"}
              onChange={(e) => update({ playwright: e.currentTarget.value === "true" })}
            >
              <option value="false">Disabled (default)</option>
              <option value="true">Enabled</option>
            </FieldSelect>
          </Field>
          <Field label="Git integration" hint="When on (codegen only), Aider uses git for commits. Review always disables git (read-only mount).">
            <FieldSelect
              value={state.git ? "true" : "false"}
              onChange={(e) => update({ git: e.currentTarget.value === "true" })}
            >
              <option value="true">Enabled (default)</option>
              <option value="false">Disabled</option>
            </FieldSelect>
          </Field>
        </>
      )}

      {provider === "goose" && (
        <Field label="Developer extension" hint="When on (codegen only), Goose can edit files and run shell via the builtin developer extension. Review always disables it (read-only).">
          <FieldSelect
            value={state.developerExtension ? "true" : "false"}
            onChange={(e) => update({ developerExtension: e.currentTarget.value === "true" })}
          >
            <option value="true">Enabled (default)</option>
            <option value="false">Disabled</option>
          </FieldSelect>
        </Field>
      )}
    </div>
  );
}
