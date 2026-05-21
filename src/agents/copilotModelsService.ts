/**
 * Copilot Models Service.
 *
 * Exchanges an OAuth token for a Copilot session token and fetches the list
 * of available models from the Copilot API. Filters and sorts by capability.
 */

import { getLogger } from "../logger.js";

const log = getLogger("copilot-models-service");

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

export type ModelCategory = "powerful" | "versatile" | "balanced" | "lightweight" | "unknown";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface CopilotModel {
  id: string;
  name: string;
  vendor: string;
  version: string;
  category: ModelCategory;
  contextWindowTokens?: number | undefined;
  capabilities?: {
    type?: string | undefined;
    family?: string | undefined;
    [key: string]: unknown;
  } | undefined;
  supportedReasoningEfforts?: ReasoningEffort[] | undefined;
}

export interface CopilotModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface CopilotTokenResponse {
  token?: string | undefined;
}

interface RawModelEntry {
  id?: string | undefined;
  name?: string | undefined;
  vendor?: string | undefined;
  version?: string | undefined;
  model_picker_category?: string | undefined;
  capabilities?: {
    type?: string | undefined;
    family?: string | undefined;
    limits?: {
      max_context_window_tokens?: number | undefined;
      [key: string]: unknown;
    } | undefined;
    supports?: {
      /** REST API returns an array of supported effort levels, not a boolean. */
      reasoning_effort?: string[] | undefined;
      [key: string]: unknown;
    } | undefined;
    [key: string]: unknown;
  } | undefined;
  model_picker_enabled?: boolean | undefined;
  policy?: {
    state?: string | undefined;
  } | undefined;
}

interface CopilotModelsResponse {
  data?: RawModelEntry[] | undefined;
}

const CATEGORY_ORDER: Record<ModelCategory, number> = {
  powerful: 0,
  versatile: 1,
  balanced: 2,
  lightweight: 3,
  unknown: 4,
};

/**
 * Exchange a GitHub OAuth token (`ghu_...`) for a short-lived Copilot session
 * token. This session token is used for API calls to `api.githubcopilot.com`.
 */
export async function exchangeForSessionToken(
  githubToken: string,
  deps: CopilotModelsServiceDependencies = {},
): Promise<string> {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  const res = await fetchFn(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      "Authorization": `token ${githubToken}`,
      "Accept": "application/json",
      "User-Agent": "virtual-engineer",
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as CopilotTokenResponse;
  const token = data.token?.trim();
  if (!token) {
    throw new Error("Copilot token exchange returned no token");
  }

  return token;
}

function isValidReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === "none" || v === "low" || v === "medium" || v === "high" || v === "xhigh";
}

/**
 * Fetch available Copilot models using a session token.
 *
 * Applies the full filter chain:
 *  1. `capabilities.type == "chat"`
 *  2. `model_picker_enabled == true`
 *  3. Policy not blocked
 *
 * Deduplicates by model version and sorts by category (powerful first).
 */
export async function fetchAvailableModels(
  sessionToken: string,
  deps: CopilotModelsServiceDependencies = {},
): Promise<CopilotModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  log.info("fetching available Copilot models");

  const res = await fetchFn(COPILOT_MODELS_URL, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${sessionToken}`,
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "copilot-chat/1.0.0",
      "User-Agent": "virtual-engineer",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot models API returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as CopilotModelsResponse;
  const raw = data.data ?? [];

  // Filter
  const filtered = raw.filter((m) => {
    if (!m.id) return false;
    if (m.capabilities?.type !== "chat") return false;
    if (m.model_picker_enabled !== true) return false;
    if (m.policy?.state === "blocked") return false;
    return true;
  });

  // Map to our model type — use model_picker_category from API when available,
  // fall back to name-based inference. Include context window and full capabilities.
  const models: CopilotModel[] = filtered.map((m) => {
    const model: CopilotModel = {
      id: m.id!,
      name: m.name ?? m.id!,
      vendor: m.vendor ?? "",
      version: m.version ?? "",
      category: toModelCategory(m.model_picker_category) ?? inferCategory(m.name ?? m.id!),
    };
    const ctx = m.capabilities?.limits?.max_context_window_tokens;
    if (ctx !== undefined) {
      model.contextWindowTokens = ctx;
    }
    if (m.capabilities !== undefined) {
      model.capabilities = m.capabilities;
    }
    // capabilities.supports.reasoning_effort is a string[] in the Copilot REST API
    // (e.g. ["none","low","medium","high"]) — filter out unrecognised values.
    const rawEfforts = m.capabilities?.supports?.reasoning_effort;
    if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
      const valid = rawEfforts.filter(isValidReasoningEffort);
      if (valid.length > 0) model.supportedReasoningEfforts = valid;
    }
    return model;
  });

  // Deduplicate by version (keep first occurrence per id)
  const seen = new Set<string>();
  const deduped = models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Sort by category order
  deduped.sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);

  log.info({ count: deduped.length }, "fetched and filtered Copilot models");
  return deduped;
}

/**
 * Map a model_picker_category string from the API to our ModelCategory.
 * Returns undefined if the value is not a recognised category.
 */
function toModelCategory(raw: string | undefined): ModelCategory | undefined {
  if (raw === "powerful" || raw === "versatile" || raw === "balanced" || raw === "lightweight") {
    return raw;
  }
  return undefined;
}

/**
 * Infer a model's category from its name/id.
 * Used as a fallback when model_picker_category is absent or unrecognised.
 */
function inferCategory(nameOrId: string): ModelCategory {
  const lower = nameOrId.toLowerCase();
  // Check lightweight first (mini/nano substrings appear in versatile model names like gpt-4o-mini)
  if (lower.includes("mini") || lower.includes("nano")) {
    return "lightweight";
  }
  if (lower.includes("o1") || lower.includes("o3") || lower.includes("opus") || lower.includes("pro")) {
    return "powerful";
  }
  if (lower.includes("4o") || lower.includes("sonnet") || lower.includes("gpt-4")) {
    return "versatile";
  }
  if (lower.includes("haiku") || lower.includes("flash")) {
    return "balanced";
  }
  return "unknown";
}
