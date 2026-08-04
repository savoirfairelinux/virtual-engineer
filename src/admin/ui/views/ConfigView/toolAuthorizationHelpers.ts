/**
 * Pure (non-React) helpers for per-agent tool authorization form state.
 *
 * Extracted from `ToolAuthorizationSection.tsx` so they can be unit-tested
 * without a DOM and imported from `.ts` test files.
 */
import type { ApiPlugin } from "../../types.js";

/** A known tool the user can toggle in the checklist. */
export interface ToolCatalogEntry {
  /** The tool identifier used in allow/block lists (bare name or pattern). */
  value: string;
  /** Human-readable label for the checkbox. */
  label: string;
  /** Short description shown as the checkbox hint. */
  hint?: string;
}

/** Curated, provider-specific catalog of known tools the user can toggle. */
export const CLAUDE_TOOL_CATALOG: ToolCatalogEntry[] = [
  { value: "Read", label: "Read", hint: "Read files from the workspace" },
  { value: "Edit", label: "Edit", hint: "Edit existing files" },
  { value: "Write", label: "Write", hint: "Create or overwrite files" },
  { value: "Bash", label: "Bash", hint: "Run shell commands" },
  { value: "Glob", label: "Glob", hint: "Fast file-pattern matching" },
  { value: "Grep", label: "Grep", hint: "Search file contents (ripgrep)" },
  { value: "Skill", label: "Skill", hint: "Invoke a discovered skill" },
  { value: "WebFetch", label: "WebFetch", hint: "Fetch a URL (blocked by network floor)" },
  { value: "WebSearch", label: "WebSearch", hint: "Search the web (blocked by network floor)" },
];

/** Copilot's first-party tools, identified by the names the worker permission
 * wrapper uses (networkGuard.ts requestToolIdentity maps request.kind to these
 * Claude-style names: shell→Bash, url→WebFetch, read→Read, write→Write). */
export const COPILOT_TOOL_CATALOG: ToolCatalogEntry[] = [
  { value: "Read", label: "Read", hint: "Read files from the workspace" },
  { value: "Write", label: "Write", hint: "Create or overwrite files" },
  { value: "Bash", label: "Bash", hint: "Run shell commands" },
  { value: "WebFetch", label: "WebFetch", hint: "Fetch a URL (blocked by network floor)" },
];

/** Get the curated tool catalog for a provider (empty for non-list providers). */
export function getToolCatalog(provider: string | undefined): ToolCatalogEntry[] {
  if (provider === "claude") return CLAUDE_TOOL_CATALOG;
  if (provider === "copilot") return COPILOT_TOOL_CATALOG;
  return [];
}

export interface ToolAuthorizationState {
  /** Claude/Copilot: selected blocked tool names/patterns (from checklist + custom). */
  blockedTools: string[];
  /** Claude/Copilot: free-text custom blocked patterns (one per line) for tools not in the catalog. */
  blockedToolsCustom: string;
  /** Aider toggles. */
  suggestShellCommands: boolean;
  detectUrls: boolean;
  playwright: boolean;
  git: boolean;
  /** Goose. */
  developerExtension: boolean;
}

export function emptyToolAuthorization(): ToolAuthorizationState {
  return {
    blockedTools: [],
    blockedToolsCustom: "",
    suggestShellCommands: false,
    detectUrls: false,
    playwright: false,
    git: true,
    developerExtension: true,
  };
}

/** Load toolAuthorization from an agent's modelConfig.providerOptions.toolAuthorization. */
export function loadToolAuthorization(
  raw: unknown,
  provider: string | undefined,
): ToolAuthorizationState {
  const state = emptyToolAuthorization();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return state;
  const auth = raw as Record<string, unknown>;
  if (provider === "claude" || provider === "copilot") {
    const catalogValues = new Set(getToolCatalog(provider).map((t) => t.value));
    const blocked = asStringArray(auth["blockedTools"]);
    // Split known catalog tools (checkboxes) from custom patterns (free text).
    state.blockedTools = blocked.filter((t) => catalogValues.has(t));
    state.blockedToolsCustom = blocked.filter((t) => !catalogValues.has(t)).join("\n");
  } else if (provider === undefined && Array.isArray(auth["blockedTools"])) {
    // Provider not yet resolved (e.g. integrations still loading): preserve
    // saved blockedTools as custom patterns so the config isn't lost on edit.
    state.blockedToolsCustom = asStringArray(auth["blockedTools"]).join("\n");
  }
  if (provider === "aider") {
    state.suggestShellCommands = asBoolean(auth["suggestShellCommands"], false);
    state.detectUrls = asBoolean(auth["detectUrls"], false);
    state.playwright = asBoolean(auth["playwright"], false);
    state.git = asBoolean(auth["git"], true);
  }
  if (provider === "goose") {
    state.developerExtension = asBoolean(auth["developerExtension"], true);
  }
  return state;
}

/** Serialize the form state back into the toolAuthorization object, or
 * `undefined` when nothing is set. */
export function serializeToolAuthorization(
  state: ToolAuthorizationState,
  provider: string | undefined,
): Record<string, unknown> | undefined {
  if (provider === "claude" || provider === "copilot") {
    const blocked = [...state.blockedTools, ...splitMultiline(state.blockedToolsCustom)];
    if (blocked.length === 0) return undefined;
    return { blockedTools: blocked };
  }
  if (provider === "aider") {
    // Only persist when the user changed something from the defaults, to avoid
    // config churn and "freezing" defaults per-agent.
    const defaults = emptyToolAuthorization();
    if (
      state.suggestShellCommands === defaults.suggestShellCommands &&
      state.detectUrls === defaults.detectUrls &&
      state.playwright === defaults.playwright &&
      state.git === defaults.git
    ) {
      return undefined;
    }
    return {
      suggestShellCommands: state.suggestShellCommands,
      detectUrls: state.detectUrls,
      playwright: state.playwright,
      git: state.git,
    };
  }
  if (provider === "goose") {
    if (state.developerExtension === emptyToolAuthorization().developerExtension) {
      return undefined;
    }
    return { developerExtension: state.developerExtension };
  }
  return undefined;
}

/** Whether the provider supports per-agent tool authorization. */
export function supportsToolAuthorization(provider: string | undefined): boolean {
  return provider === "claude" || provider === "copilot" || provider === "aider" || provider === "goose";
}

/** Props for the ToolAuthorizationSection component. */
export interface ToolAuthorizationSectionProps {
  state: ToolAuthorizationState;
  onChange: (state: ToolAuthorizationState) => void;
  provider: string | undefined;
  plugin: ApiPlugin | undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  }
  if (typeof value === "string") {
    return splitMultiline(value);
  }
  return [];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function splitMultiline(value: string): string[] {
  return value.split("\n").map((v) => v.trim()).filter((v) => v !== "");
}
