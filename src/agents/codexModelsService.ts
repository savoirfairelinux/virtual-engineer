/**
 * Codex models service.
 *
 * For API-key integrations, discovers available models from the OpenAI
 * `/v1/models` endpoint. For subscription (access-token) integrations that
 * endpoint is not reachable with a ChatGPT-managed token, so the models are
 * discovered by running `codex debug models` inside the agent container image
 * instead — the CLI's own live, network-refreshed catalog (not its bundled
 * fallback), so the list tracks whatever OpenAI ships without VE maintaining
 * a hand-written duplicate that drifts out of date. The chosen model is
 * stored on the `agents` table and passed to the CLI via `--model`.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("codex-models-service");

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const execFileAsync = promisify(execFileCb);

export interface CodexModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  /** Injectable for tests — defaults to Node's `execFile` (`docker run ...`). */
  execFile?: ((file: string, args: string[]) => Promise<{ stdout: string }>) | undefined;
}

interface RawOpenAiModel {
  id?: string | undefined;
}

interface OpenAiModelsResponse {
  data?: RawOpenAiModel[] | undefined;
}

interface RawCodexCatalogModel {
  slug?: string | undefined;
  display_name?: string | undefined;
  visibility?: string | undefined;
  priority?: number | undefined;
  supported_in_api?: boolean | undefined;
}

interface CodexCatalogResponse {
  models?: RawCodexCatalogModel[] | undefined;
}

/**
 * Discover Codex-capable models for subscription (access-token) integrations
 * by running `codex debug models` inside the agent container image (which
 * already has the Codex CLI installed). This requires no credentials — the
 * catalog itself is public — and reflects the CLI's live-refreshed model
 * list, ordered by the priority the CLI itself assigns.
 */
export async function fetchCodexSubscriptionModels(
  deps: CodexModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const exec = deps.execFile ?? ((file: string, args: string[]): Promise<{ stdout: string }> =>
    execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 }));
  const image = getConfig().agentContainerImage;

  let stdout: string;
  try {
    ({ stdout } = await exec("docker", ["run", "--rm", image, "codex", "debug", "models"]));
  } catch (err) {
    throw new Error(
      `Failed to query the Codex model catalog via agent image "${image}": ` +
      (err instanceof Error ? err.message : String(err))
    );
  }

  const data = JSON.parse(stdout) as CodexCatalogResponse;
  const models = (data.models ?? [])
    .filter((m): m is RawCodexCatalogModel & { slug: string } =>
      typeof m.slug === "string" && m.slug.length > 0 && m.visibility === "list" && m.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map((m) => ({
      id: m.slug,
      name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : m.slug,
    }));

  log.info({ count: models.length }, "discovered Codex models via CLI catalog");
  return models;
}

/** Fetch the list of models available to an OpenAI API key. */
export async function fetchOpenAiModels(
  apiKey: string,
  deps: CodexModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const res = await fetchFn(OPENAI_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  });

  if (!res.ok) {
    throw new Error(`OpenAI models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as OpenAiModelsResponse;
  const models = (data.data ?? [])
    .map((m) => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      return id ? { id, name: id } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  log.info({ count: models.length }, "discovered OpenAI models");
  return models;
}
