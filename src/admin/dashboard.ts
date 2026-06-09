import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// process.cwd() is the project root in both dev (tsx src/) and prod (compiled dist/).
const DIST_UI = resolve(process.cwd(), "dist/admin-ui");

interface ViteManifestEntry {
  file: string;
  css?: string[];
}

function loadViteManifest(): Record<string, ViteManifestEntry> | null {
  const manifestPath = `${DIST_UI}/.vite/manifest.json`;
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ViteManifestEntry>;
  } catch { return null; }
}

// Cached at module init — invalidate on restart.
let _manifest: Record<string, ViteManifestEntry> | null | undefined;
function getManifest(): Record<string, ViteManifestEntry> | null {
  if (_manifest === undefined) _manifest = loadViteManifest();
  return _manifest;
}

export function renderAdminDashboardHtml(options?: {
  requiresAuth?: boolean | undefined;
  authMode?: "none" | "bearer" | "hmac" | "mixed" | undefined;
  gerritBaseUrl?: string | undefined;
  gitlabBaseUrl?: string | undefined;
  ticketLinkTemplates?: Record<string, string> | undefined;
  nonce?: string | undefined;
}): string {
  // ⚠️ SECURITY: Escape HTML special characters in bootstrap JSON to prevent XSS.
  // JSON embedded in <script> tags must be carefully escaped to avoid breaking out of the string context.
  const bootstrap = JSON.stringify({
    requiresAuth: options?.requiresAuth ?? false,
    authMode: options?.authMode ?? "none",
    gerritBaseUrl: options?.gerritBaseUrl ?? null,
    gitlabBaseUrl: options?.gitlabBaseUrl ?? null,
    ticketLinkTemplates: options?.ticketLinkTemplates ?? {},
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  const nonce = options?.nonce ?? "";
  const manifest = getManifest();
  // Vite uses "index.html" as the manifest key when the HTML file is the entry point.
  const entry = manifest?.["index.html"];
  const jsFile  = entry ? `/admin-ui/${entry.file}` : null;
  const cssFiles: string[] = entry?.css?.map((f) => `/admin-ui/${f}`) ?? [];

  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Virtual Engineer — Admin</title>
    ${cssFiles.map((f) => `<link rel="stylesheet" href="${f}" />`).join("\n    ")}
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__VE_ADMIN_BOOTSTRAP__ = ${bootstrap};</script>
    ${jsFile ? `<script type="module" src="${jsFile}"></script>` : `<script nonce="${nonce}">document.getElementById("root").textContent = "Admin UI not built — run npm run build:ui";</script>`}
  </body>
</html>`;
}
