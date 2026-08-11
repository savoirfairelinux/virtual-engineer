/**
 * Egress hosts required by the LLM backends the Aider and Goose CLIs can talk
 * to. The OpenShell runtime is deny-by-default, so an agent whose backend host
 * is not listed here cannot reach its model API at all.
 */
import type { AgentEgressSpec } from "../interfaces.js";

const AIDER_BACKEND_HOSTS: Record<string, readonly string[]> = {
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  ollama: [],
  openrouter: ["openrouter.ai"],
  deepseek: ["api.deepseek.com"],
  openai_compat: [],
};

const GOOSE_PROVIDER_HOSTS: Record<string, readonly string[]> = {
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai"],
  ollama: [],
  deepseek: ["api.deepseek.com"],
  groq: ["api.groq.com"],
  gemini: ["generativelanguage.googleapis.com"],
  azure_openai: [],
  bedrock: ["bedrock-runtime.us-east-1.amazonaws.com", "sts.amazonaws.com"],
  perplexity: ["api.perplexity.ai"],
  mistral: ["api.mistral.ai"],
  xai: ["api.x.ai"],
  cerebras: ["api.cerebras.ai"],
  openai_compat: [],
};

/** `host` or `host:port` for a configured API base; empty when it is not a URL. */
function hostOf(apiBase: string | undefined): string[] {
  const trimmed = apiBase?.trim();
  if (!trimmed) return [];
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return [];
    return [url.port ? `${url.hostname}:${url.port}` : url.hostname];
  } catch {
    return [];
  }
}

function egress(hosts: readonly string[], extraBase: string | undefined, binary: string): AgentEgressSpec | undefined {
  const all = [...new Set([...hosts, ...hostOf(extraBase)])];
  return all.length > 0 ? { hosts: all, binaries: [binary] } : undefined;
}

export function aiderEgress(backend: string | undefined, apiBase: string | undefined): AgentEgressSpec | undefined {
  return egress(AIDER_BACKEND_HOSTS[backend ?? "openai"] ?? [], apiBase, "/usr/local/bin/aider");
}

export function gooseEgress(provider: string | undefined, apiBase: string | undefined): AgentEgressSpec | undefined {
  return egress(GOOSE_PROVIDER_HOSTS[provider ?? "anthropic"] ?? [], apiBase, "/usr/local/bin/goose");
}
