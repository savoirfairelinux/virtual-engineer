import type { ToneKey } from "../../states.ts";
import type { SkillSource } from "./ProjectSkillSourcesField.tsx";

export interface TicketSource {
  integrationId: string;
  ticketProjectKey: string;
}

export interface PushTarget {
  integrationId: string;
  repoKey: string;
  cloneUrl: string;
  targetBranch: string;
  localPath: string;
  localPathMode: "fixed" | "derived";
  origin: "manual" | "workspace_scan";
  relation?: WorkspaceScanRepository["relation"] | undefined;
  /** Comma-separated reviewer emails, as typed in the form. */
  reviewerEmails: string;
}

export type EditablePushTargetField = "integrationId" | "cloneUrl" | "targetBranch" | "reviewerEmails";

export interface RepositoryBindingCandidate {
  integrationId: string;
  integrationName: string;
  provider: string;
  repoKey: string;
  enabled: boolean;
}

export interface RepositoryBindingResolutionBase {
  cloneUrl: string;
  localPath?: string;
}

export type RepositoryBindingResolution = RepositoryBindingResolutionBase & (
  | { status: "matched"; match: RepositoryBindingCandidate; candidates: [] }
  | { status: "ambiguous"; match: null; candidates: RepositoryBindingCandidate[] }
  | { status: "unmatched"; match: null; candidates: [] }
);

export interface WorkspaceScanRepository {
  cloneUrl: string | null;
  localPath: string;
  revision: string | null;
  relation: "gitlink" | "manifest_member" | "contains" | "fetched";
  sourcePath: string;
  origin: VendorComponentOrigin;
}

export type VendorComponentOrigin = "internal" | "fork_pushable" | "patch_required" | "ambiguous";

export interface VendorComponentRow {
  sourcePath: string;
  localPath: string | null;
  cloneUrl: string | null;
  revision: string | null;
  origin: VendorComponentOrigin;
}

export const VENDOR_ORIGIN_LABELS: Record<VendorComponentOrigin, string> = {
  internal: "internal",
  fork_pushable: "pushable",
  patch_required: "patch only",
  ambiguous: "ambiguous",
};

export const VENDOR_ORIGIN_TONES: Record<VendorComponentOrigin, ToneKey> = {
  internal: "muted",
  fork_pushable: "ok",
  patch_required: "warn",
  ambiguous: "danger",
};

/** One manifest declares many components, so identity is the pair, not the manifest. */
export function vendorComponentKey(component: { sourcePath: string; localPath: string | null }): string {
  return `${component.sourcePath}\u0000${component.localPath ?? ""}`;
}

export function vendorComponentName(component: { sourcePath: string; localPath: string | null }): string {
  return component.localPath ?? component.sourcePath;
}

export interface WorkspaceScanDiagnostic {
  sourcePath: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface WorkspacePushTargetScanResponse {
  manifestFiles: string[];
  repositories: WorkspaceScanMember[];
  diagnostics: WorkspaceScanDiagnostic[];
}

export interface WorkspaceScanMember extends WorkspaceScanRepository {
  resolution: RepositoryBindingResolution | null;
}

export interface WorkspaceScanPreview {
  manifestFiles: string[];
  members: WorkspaceScanMember[];
  diagnostics: WorkspaceScanDiagnostic[];
}

export const WORKSPACE_MEMBER_ROW_HEIGHT = 56;
export const WORKSPACE_MEMBER_GAP = 4;
export const WORKSPACE_MEMBER_VISIBLE_ROWS = 5;
export const WORKSPACE_MEMBER_LIST_MAX_HEIGHT = WORKSPACE_MEMBER_ROW_HEIGHT * WORKSPACE_MEMBER_VISIBLE_ROWS
  + WORKSPACE_MEMBER_GAP * (WORKSPACE_MEMBER_VISIBLE_ROWS - 1);

export function workspaceMemberSearchText(member: WorkspaceScanMember): string {
  const resolution = member.resolution;
  const resolutionText = resolution?.status === "matched"
    ? `${resolution.status} ${resolution.match.integrationName} ${resolution.match.repoKey}`
    : resolution?.status ?? "in-repo layer";
  return [
    member.localPath,
    member.sourcePath,
    member.relation,
    member.cloneUrl,
    member.revision,
    resolutionText,
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
}

export type SaveCheckStatus = "checking" | "checked" | "failed" | "cancelled" | "not_checked";

export interface SaveCheckSource {
  source: string;
  sshUser?: string;
  sshPort?: number;
  status: SaveCheckStatus;
}

export interface RepositoryOption {
  key: string;
  name: string;
  cloneUrlSsh?: string;
  cloneUrlHttp?: string;
  defaultBranch?: string;
  webUrl?: string;
}

export interface TicketProjectOption {
  key: string;
  name: string;
  url?: string;
}

export function emptyPushTarget(): PushTarget {
  return { integrationId: "", repoKey: "", cloneUrl: "", targetBranch: "main", localPath: ".", localPathMode: "fixed", origin: "manual", reviewerEmails: "" };
}

export function manualLocalPath(repoKey: string, fallback: string, targets: PushTarget[], targetIndex: number): string {
  const repositoryName = repoKey.trim().split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "";
  const normalized = repositoryName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
  const occupied = new Set(targets.flatMap((target, index) => index === targetIndex ? [] : [target.localPath]));
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function legacyRoleForPushTarget(target: PushTarget): "primary" | "submodule" | "dependency" | "related" {
  if (target.localPath === ".") return "primary";
  if (target.relation === "gitlink") return "submodule";
  if (target.relation === "contains") return "related";
  return "dependency";
}

export function firstTargetBranch(revision: string | null, defaultBranch: string | undefined): string {
  const candidate = revision?.trim();
  if (!candidate || candidate === "HEAD" || /^refs\/(?!heads\/)/.test(candidate) || /^[0-9a-f]{7,40}$/i.test(candidate)) {
    return defaultBranch || "main";
  }
  return candidate.replace(/^refs\/heads\//, "");
}

export function saveCheckSourcesFromSkillSources(sources: SkillSource[], status: SaveCheckStatus): SaveCheckSource[] {
  return sources.map((source) => ({
    source: source.source,
    status,
    ...(source.sshUser !== undefined ? { sshUser: source.sshUser } : {}),
    ...(source.sshPort !== undefined ? { sshPort: source.sshPort } : {}),
  }));
}

export function checkedSourcesAfterError(sources: SaveCheckSource[], message: string): SaveCheckSource[] {
  const match = /Skill source #(\d+)/.exec(message);
  if (!match) {
    const checkFailed = message.includes("Failed to validate skill sources") || message.includes("SSH connection check failed");
    return sources.map((source) => ({ ...source, status: checkFailed ? "failed" : "checked" }));
  }
  const failedIndex = Number.parseInt(match[1] ?? "", 10) - 1;
  if (!Number.isInteger(failedIndex) || failedIndex < 0 || failedIndex >= sources.length) {
    return sources.map((source) => ({ ...source, status: "failed" }));
  }
  return sources.map((source, index) => ({
    ...source,
    status: index < failedIndex ? "checked" : index === failedIndex ? "failed" : "not_checked",
  }));
}

export function saveCheckStatusLabel(status: SaveCheckStatus): string {
  switch (status) {
    case "checking": return "checking";
    case "checked": return "checked";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "not_checked": return "not checked";
  }
}

export function normalizeRepository(option: RepositoryOption | string | null | undefined): RepositoryOption | null {
  if (!option) return null;
  if (typeof option === "string") {
    return { key: option, name: option };
  }
  if (typeof option.key !== "string" || !option.key || typeof option.name !== "string" || !option.name) {
    return null;
  }
  return option;
}

export function repositoryLabel(repo: RepositoryOption): string {
  const extra = [repo.defaultBranch, repo.webUrl].filter((v) => typeof v === "string" && v.length > 0) as string[];
  return extra.length > 0 ? `${repo.name} · ${extra[0]}` : repo.name;
}

export function normalizeTicketProject(item: TicketProjectOption | string | null | undefined): TicketProjectOption | null {
  if (!item) return null;
  if (typeof item === "string") return { key: item, name: item };
  if (typeof item.key !== "string" || !item.key) return null;
  return { key: item.key, name: (item.name && item.name.length > 0) ? item.name : item.key, ...(item.url ? { url: item.url } : {}) };
}
