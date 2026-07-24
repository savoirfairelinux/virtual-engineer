import { buildGitLabAuthHeaders, rewriteGitLabUploadUrl } from "../utils/gitlabAuth.js";

export const GITLAB_IMAGE_PROXY_MAX_BYTES = 5 * 1024 * 1024;
export const GITLAB_IMAGE_PROXY_TIMEOUT_MS = 10_000;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

export type GitLabProxyImageResult =
  | { ok: true; contentType: string; body: Buffer }
  | { ok: false; statusCode: 413 | 502; error: string };

export interface FetchGitLabProxyImageInput {
  targetUrl: string;
  gitlabBaseUrl: string;
  gitlabToken: string;
  fetchImpl?: typeof fetch | undefined;
  maxResponseBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

function normalizedContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function fetchGitLabProxyImage(
  input: FetchGitLabProxyImageInput
): Promise<GitLabProxyImageResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const maxResponseBytes = input.maxResponseBytes ?? GITLAB_IMAGE_PROXY_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? GITLAB_IMAGE_PROXY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchUrl = rewriteGitLabUploadUrl(input.targetUrl, input.gitlabBaseUrl);
    const response = await fetchImpl(fetchUrl, {
      ...(input.gitlabToken
        ? { headers: buildGitLabAuthHeaders(input.gitlabToken) }
        : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, statusCode: 502, error: "Upstream image request failed" };
    }

    const contentType = normalizedContentType(response.headers.get("content-type"));
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      return { ok: false, statusCode: 502, error: "Upstream did not return an image" };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        await response.body?.cancel();
        return { ok: false, statusCode: 502, error: "Upstream returned an invalid content length" };
      }
      if (declaredBytes > maxResponseBytes) {
        await response.body?.cancel();
        return { ok: false, statusCode: 413, error: "Upstream image is too large" };
      }
    }

    const body = await readBoundedBody(response, maxResponseBytes);
    if (!body) {
      return response.body
        ? { ok: false, statusCode: 413, error: "Upstream image is too large" }
        : { ok: false, statusCode: 502, error: "Upstream image body is unavailable" };
    }
    return { ok: true, contentType, body };
  } catch {
    return controller.signal.aborted
      ? { ok: false, statusCode: 502, error: "Proxy fetch timed out" }
      : { ok: false, statusCode: 502, error: "Proxy fetch failed" };
  } finally {
    clearTimeout(timeout);
  }
}