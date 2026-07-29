export const CONFIG_SECTIONS = [
  "overview",
  "integrations",
  "oauth",
  "agents",
  "projects",
  "prompts",
  "users",
  "groups",
  "policies",
  "audit",
  "system",
] as const;

export type ConfigSectionId = typeof CONFIG_SECTIONS[number];

type ConfigEntitySection = Exclude<ConfigSectionId, "overview" | "audit" | "system">;
type ConfigStandardEntitySection = Exclude<ConfigEntitySection, "oauth">;

export type ConfigRoute =
  | { section: ConfigSectionId; mode: "list" }
  | { section: ConfigEntitySection; mode: "create" }
  | { section: ConfigStandardEntitySection; mode: "detail" | "edit"; id: string }
  | { section: "users"; mode: "password"; id: string }
  | { section: "oauth"; mode: "detail"; provider: string; baseUrl: string };

const DEFAULT_ROUTE: ConfigRoute = { section: "overview", mode: "list" };
const ENTITY_SECTIONS = new Set<ConfigSectionId>([
  "integrations",
  "oauth",
  "agents",
  "projects",
  "prompts",
  "users",
  "groups",
  "policies",
]);

function isConfigSection(value: string): value is ConfigSectionId {
  return CONFIG_SECTIONS.some((section) => section === value);
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function parseConfigHash(hash: string): ConfigRoute {
  const segments = hash.replace(/^#/, "").split("/");
  if (segments[0] !== "config") return DEFAULT_ROUTE;

  const rawSection = segments[1] ?? "overview";
  if (!isConfigSection(rawSection)) return DEFAULT_ROUTE;
  if (segments.length === 2) return { section: rawSection, mode: "list" };
  if (!ENTITY_SECTIONS.has(rawSection)) return DEFAULT_ROUTE;

  if (segments.length === 3 && segments[2] === "new") {
    return { section: rawSection as ConfigEntitySection, mode: "create" };
  }

  if (rawSection === "oauth") {
    if (segments.length !== 4) return DEFAULT_ROUTE;
    const provider = decodeSegment(segments[2] ?? "");
    const baseUrl = decodeSegment(segments[3] ?? "");
    return provider && baseUrl
      ? { section: "oauth", mode: "detail", provider, baseUrl }
      : DEFAULT_ROUTE;
  }

  const id = decodeSegment(segments[2] ?? "");
  if (!id) return DEFAULT_ROUTE;
  if (segments.length === 3) {
    return { section: rawSection as ConfigStandardEntitySection, mode: "detail", id };
  }
  if (segments.length !== 4) return DEFAULT_ROUTE;
  if (segments[3] === "edit") {
    return { section: rawSection as ConfigStandardEntitySection, mode: "edit", id };
  }
  if (rawSection === "users" && segments[3] === "password") {
    return { section: "users", mode: "password", id };
  }
  return DEFAULT_ROUTE;
}

export function formatConfigHash(route: ConfigRoute): string {
  const root = `#config/${route.section}`;
  if (route.mode === "list") return root;
  if (route.mode === "create") return `${root}/new`;
  if (route.section === "oauth") {
    return `${root}/${encodeURIComponent(route.provider)}/${encodeURIComponent(route.baseUrl)}`;
  }

  const itemRoot = `${root}/${encodeURIComponent(route.id)}`;
  if (route.mode === "detail") return itemRoot;
  return `${itemRoot}/${route.mode}`;
}