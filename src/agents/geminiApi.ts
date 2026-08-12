export interface GeminiApiRoutingConfig {
  authMode?: string | undefined;
  apiKey: string;
  googleCloudProject?: string | undefined;
  googleCloudLocation?: string | undefined;
}

export interface GeminiModelsRequest {
  url: string;
  headers: Record<string, string>;
}

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const VERTEX_MODELS_PATH = "/v1beta1/publishers/google/models";

export function resolveGeminiVertexHost(location: string | undefined): string {
  const normalizedLocation = location?.trim().toLowerCase() ?? "";
  if (!normalizedLocation) return "aiplatform.googleapis.com";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedLocation)) {
    throw new Error(`Invalid Google Cloud location '${location ?? ""}'.`);
  }
  if (normalizedLocation === "us" || normalizedLocation === "eu") {
    return `aiplatform.${normalizedLocation}.rep.googleapis.com`;
  }
  return `${normalizedLocation}-aiplatform.googleapis.com`;
}

export function buildGeminiModelsRequest(config: GeminiApiRoutingConfig): GeminiModelsRequest {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "virtual-engineer",
  };
  if (config.authMode === "vertex_ai") {
    headers["x-goog-api-key"] = config.apiKey;
    return {
      url: `https://${resolveGeminiVertexHost(config.googleCloudLocation)}${VERTEX_MODELS_PATH}`,
      headers,
    };
  }
  return {
    url: `${GEMINI_MODELS_URL}?key=${encodeURIComponent(config.apiKey)}`,
    headers,
  };
}