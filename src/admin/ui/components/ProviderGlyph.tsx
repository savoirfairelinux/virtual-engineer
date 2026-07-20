import { useEffect, useState } from "react";

/* ─── Brand SVG map (resolved at build time by Vite) ───────────────────── */

const BRAND_SVG_FILES = import.meta.glob("../icons/brands/*.svg", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const BRAND_SVG_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(BRAND_SVG_FILES).map(([filePath, src]) => {
    const name = (filePath.split("/").pop() ?? "mock.svg").replace(/\.svg$/, "");
    return [name, src];
  })
);

const TYPE_TO_BRAND: Record<string, string> = {
  // Unified provider keys (post-refactor)
  github:                 "github",
  gitlab:                 "gitlab",
  // Legacy split-descriptor keys (kept for backwards compat with old DB rows)
  "github-issue":         "github",
  "github-pull-request":  "github",
  "gitlab-issue":         "gitlab",
  "gitlab-merge-request": "gitlab",
  gerrit:                 "gerrit",
  redmine:                "redmine",
  copilot:                "copilot",
  claude:                 "claude",
  aider:                  "aider",
  mock:                   "mock",
};

/** Logos that need `filter: invert(1)` in dark theme (dark fill on transparent bg) */
const DARK_INVERT: ReadonlySet<string> = new Set(["github", "mock", "claude"]);
/** Logos that need `filter: invert(1)` in light theme (light fill on transparent bg) */
const LIGHT_INVERT: ReadonlySet<string> = new Set(["copilot", "gerrit"]);

type UiTheme = "dark" | "light";

function getTheme(): UiTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
}

function useUiTheme(): UiTheme {
  const [theme, setTheme] = useState<UiTheme>(getTheme);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.dataset["theme"] === "light" ? "light" : "dark");
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/* ─── Component ─────────────────────────────────────────────────────────── */

interface ProviderGlyphProps {
  provider: string;
  size?: number;
}

export function ProviderGlyph({ provider, size = 34 }: ProviderGlyphProps) {
  const theme = useUiTheme();
  const brandKey = TYPE_TO_BRAND[provider] ?? "mock";
  const src = BRAND_SVG_URLS[brandKey] ?? BRAND_SVG_URLS["mock"] ?? "";
  const logoSize = Math.round(size * 0.66);
  const shouldInvert =
    (theme === "dark" && DARK_INVERT.has(brandKey)) ||
    (theme === "light" && LIGHT_INVERT.has(brandKey));

  return (
    <span
      style={{
        width: size, height: size, borderRadius: "8px", flex: "none",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "var(--panel-2)",
        border: "1px solid var(--border-soft)",
      }}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={logoSize}
        height={logoSize}
        style={{
          display: "block",
          width: `${logoSize}px`,
          height: `${logoSize}px`,
          objectFit: "contain",
          filter: shouldInvert ? "invert(1)" : "none",
        }}
      />
    </span>
  );
}

