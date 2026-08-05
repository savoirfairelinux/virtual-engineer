import { useEffect, useRef, useState } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import { api } from "../../api.ts";
import type { ApiAgent, ApiIntegration } from "../../types.ts";
import { ProjectSkillSourcesField, buildSkillSourcesPayload, preloadedProjectSkillSourceRow, skillSourceToRow, type SkillSource, type SkillSourceRow } from "./ProjectSkillSourcesField.tsx";
import { RepositoryKeyField, RepositoryKeysField, TargetBranchField, TicketProjectKeyField } from "./ProjectFormFields.tsx";
import {
  VENDOR_ORIGIN_LABELS,
  VENDOR_ORIGIN_TONES,
  WORKSPACE_MEMBER_GAP,
  WORKSPACE_MEMBER_LIST_MAX_HEIGHT,
  WORKSPACE_MEMBER_ROW_HEIGHT,
  checkedSourcesAfterError,
  emptyPushTarget,
  firstTargetBranch,
  type EditablePushTargetField,
  legacyRoleForPushTarget,
  manualLocalPath,
  saveCheckSourcesFromSkillSources,
  saveCheckStatusLabel,
  vendorComponentKey,
  vendorComponentName,
  workspaceMemberSearchText,
  type PushTarget,
  type RepositoryBindingResolution,
  type SaveCheckSource,
  type TicketSource,
  type VendorComponentRow,
  type WorkspacePushTargetScanResponse,
  type WorkspaceScanMember,
  type WorkspaceScanPreview,
} from "./projectFormTypes.ts";

interface Props {
  agents: ApiAgent[];
  integrations: ApiIntegration[];
  project?: ProjectFormProject;
  onClose: () => void;
  onSaved: () => void;
}

interface ProjectFormProject {
  id: string;
  name: string;
  type: "coding" | "review";
  agentId: string | null;
  postCloneScript?: string;
  skillSources?: SkillSource[];
  gerritTopicOverride?: string | null;
  useFullTicketUrlInCommits?: boolean;
  postReviewLinkToTicket?: boolean;
  reactToCiFailures?: boolean;
  ticketSource?: {
    integration: { id: string; name: string; type: string } | null;
    ticketProjectKey: string;
  } | null;
  reviewConfig?: {
    integration: { id: string; name: string; type: string } | null;
    repos: string[];
  } | null;
  pushTargets?: Array<{
    integrationId: string;
    repoKey: string;
    cloneUrl: string;
    targetBranch: string;
    role: "primary" | "submodule" | "dependency" | "related";
    commitOrder: number;
    localPath: string;
    reviewerEmails?: string[];
  }>;
}

export function ProjectFormModal({ agents, integrations, project, onClose, onSaved }: Props) {
  const isEditMode = project !== undefined;
  const [projectType, setProjectType] = useState<"coding" | "review">(project?.type ?? "coding");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [postCloneScript, setPostCloneScript] = useState("");
  const [skillSourceRows, setSkillSourceRows] = useState<SkillSourceRow[]>(() => project === undefined ? [preloadedProjectSkillSourceRow()] : []);
  const [gerritTopicOverride, setGerritTopicOverride] = useState("");
  const [useFullTicketUrlInCommits, setUseFullTicketUrlInCommits] = useState(false);
  const [postReviewLinkToTicket, setPostReviewLinkToTicket] = useState(false);
  const [reactToCiFailures, setReactToCiFailures] = useState(false);

  // Coding-specific
  const [ticketSource, setTicketSource] = useState<TicketSource>({ integrationId: "", ticketProjectKey: "" });
  const [pushTargets, setPushTargets] = useState<PushTarget[]>([emptyPushTarget()]);

  // Review-specific
  const [reviewIntegrationId, setReviewIntegrationId] = useState("");
  const [reviewRepoKeys, setReviewRepoKeys] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveCheckSources, setSaveCheckSources] = useState<SaveCheckSource[]>([]);
  const saveAbortRef = useRef<AbortController | null>(null);
  const [repositoryResolutionMessages, setRepositoryResolutionMessages] = useState<Record<string, string>>({});
  const [workspaceScans, setWorkspaceScans] = useState<Record<string, WorkspaceScanPreview>>({});
  const [workspaceScanQueries, setWorkspaceScanQueries] = useState<Record<string, string>>({});
  const [scanningWorkspaceUrl, setScanningWorkspaceUrl] = useState<string | null>(null);
  const [addingWorkspaceMember, setAddingWorkspaceMember] = useState<string | null>(null);
  const [workspaceScanErrors, setWorkspaceScanErrors] = useState<Record<string, string>>({});
  const [vendorComponents, setVendorComponents] = useState<VendorComponentRow[]>([]);
  const vendorComponentsDirtyRef = useRef(false);

  const trackVendorComponent = (member: WorkspaceScanMember) => {
    vendorComponentsDirtyRef.current = true;
    setVendorComponents((prev) => prev.some((component) => vendorComponentKey(component) === vendorComponentKey(member))
      ? prev
      : [...prev, {
        sourcePath: member.sourcePath,
        localPath: member.localPath,
        cloneUrl: member.cloneUrl,
        revision: member.revision,
        origin: member.origin,
      }]);
  };

  const removeVendorComponent = (key: string) => {
    vendorComponentsDirtyRef.current = true;
    setVendorComponents((prev) => prev.filter((component) => vendorComponentKey(component) !== key));
  };

  useEffect(() => {
    if (!project) return;
    setProjectType(project.type);
    setName(project.name);
    setAgentId(project.agentId ?? "");
    setPostCloneScript(project.postCloneScript ?? "");
    setSkillSourceRows((project.skillSources ?? []).map(skillSourceToRow));
    setGerritTopicOverride(project.gerritTopicOverride ?? "");
    setUseFullTicketUrlInCommits(project.useFullTicketUrlInCommits ?? false);
    setPostReviewLinkToTicket(project.postReviewLinkToTicket ?? false);
    setReactToCiFailures(project.reactToCiFailures ?? false);

    if (project.type === "coding") {
      setTicketSource({
        integrationId: project.ticketSource?.integration?.id ?? "",
        ticketProjectKey: project.ticketSource?.ticketProjectKey ?? "",
      });
      const nextTargets = (project.pushTargets ?? []).map((t) => ({
        integrationId: t.integrationId,
        repoKey: t.repoKey,
        cloneUrl: t.cloneUrl,
        targetBranch: t.targetBranch,
        localPath: t.localPath,
        localPathMode: "fixed" as const,
        origin: "manual" as const,
        reviewerEmails: (t.reviewerEmails ?? []).join(", "),
      }));
      setPushTargets(nextTargets.length > 0 ? nextTargets : [emptyPushTarget()]);
      setVendorComponents([]);
      vendorComponentsDirtyRef.current = false;
      void api.get<{ components: VendorComponentRow[] }>(`/api/admin/projects/${project.id}/vendor-components`)
        // A slow GET must not undo what the operator tracked while it was in flight.
        .then((response) => { if (!vendorComponentsDirtyRef.current) setVendorComponents(response.components); })
        .catch(() => { /* vendor components are optional metadata */ });
    } else {
      setReviewIntegrationId(project.reviewConfig?.integration?.id ?? "");
      setReviewRepoKeys(project.reviewConfig?.repos ?? []);
    }
  }, [project]);

  useEffect(() => {
    return () => saveAbortRef.current?.abort();
  }, []);

  const codingAgents = agents.filter((a) => a.type === "coding");
  const reviewAgents = agents.filter((a) => a.type === "review");
  const currentAgents = projectType === "coding" ? codingAgents : reviewAgents;

  const ticketingIntegrations = integrations.filter((i) => i.domainCapabilities.includes("issue_tracking"));
  const vcsIntegrations = integrations.filter((i) => i.domainCapabilities.includes("source_control"));
  const reviewIntegrations = integrations.filter((i) => i.domainCapabilities.includes("code_review"));

  const updatePushTarget = (idx: number, key: EditablePushTargetField, val: string) => {
    setPushTargets((prev) => prev.map((t, i) => i === idx ? { ...t, [key]: val } : t));
  };

  const supportsReviewerEmails = (integrationId: string) => {
    const provider = integrations.find((integration) => integration.id === integrationId)?.provider;
    return provider === "gerrit" || provider === "gitlab";
  };

  const addPushTarget = () => {
    setPushTargets((prev) => [...prev, { ...emptyPushTarget(), localPath: `repo-${prev.length + 1}`, localPathMode: "derived" }]);
  };

  const updatePushTargetRepoKey = (idx: number, repoKey: string) => {
    setPushTargets((prev) => prev.map((target, targetIndex) => {
      if (targetIndex !== idx) return target;
      // A scanned URL is often only a mirror, so the picked repository owns the clone URL instead.
      const discovered = integrations.find((candidate) => candidate.id === target.integrationId)
        ?.discoveredResources?.repositories?.find((candidate) => candidate.key === repoKey);
      const cloneUrl = discovered && (target.origin === "workspace_scan" || !target.cloneUrl.trim())
        ? discovered.cloneUrlHttp ?? discovered.cloneUrlSsh ?? target.cloneUrl
        : target.cloneUrl;
      return {
        ...target,
        repoKey,
        cloneUrl,
        ...(target.localPathMode === "derived"
          ? { localPath: manualLocalPath(repoKey, `repo-${idx + 1}`, prev, idx) }
          : {}),
      };
    }));
  };

  const removePushTarget = (idx: number) => {
    setPushTargets((prev) => prev.filter((_, i) => i !== idx));
  };

  const resolvePushTarget = async (idx: number) => {
    const target = pushTargets[idx];
    const cloneUrl = target?.cloneUrl.trim() ?? "";
    if (!target || !cloneUrl || target.integrationId || target.repoKey) return;

    setRepositoryResolutionMessages((prev) => ({ ...prev, [cloneUrl]: "Checking existing integrations…" }));
    try {
      const response = await api.post<{ repositories: RepositoryBindingResolution[] }>(
        "/api/admin/projects/resolve-repositories",
        { repositories: [{ cloneUrl, localPath: target.localPath }] },
      );
      const resolution = response.repositories[0];
      if (!resolution) {
        setRepositoryResolutionMessages((prev) => ({ ...prev, [cloneUrl]: "No integration match returned" }));
        return;
      }
      if (resolution.status === "matched" && resolution.match) {
        const match = resolution.match;
        if (!match.enabled) {
          setRepositoryResolutionMessages((prev) => ({
            ...prev,
            [cloneUrl]: `Match found in disabled integration ${match.integrationName}; select it explicitly to continue`,
          }));
          return;
        }
        const integration = integrations.find((candidate) => candidate.id === match.integrationId);
        const repository = integration?.discoveredResources?.repositories?.find((candidate) => candidate.key === match.repoKey);
        setPushTargets((prev) => prev.map((candidate, candidateIdx) => {
          if (candidateIdx !== idx || candidate.cloneUrl.trim() !== cloneUrl || candidate.integrationId || candidate.repoKey) {
            return candidate;
          }
          return {
            ...candidate,
            integrationId: match.integrationId,
            repoKey: match.repoKey,
            ...(candidate.localPathMode === "derived"
              ? { localPath: manualLocalPath(match.repoKey, `repo-${candidateIdx + 1}`, prev, candidateIdx) }
              : {}),
            targetBranch: (!candidate.targetBranch || candidate.targetBranch === "main")
              ? (repository?.defaultBranch ?? "main")
              : candidate.targetBranch,
          };
        }));
        setRepositoryResolutionMessages((prev) => ({
          ...prev,
          [cloneUrl]: `Matched ${match.integrationName}${match.enabled ? "" : " (disabled)"}`,
        }));
        return;
      }
      if (resolution.status === "ambiguous") {
        setRepositoryResolutionMessages((prev) => ({
          ...prev,
          [cloneUrl]: `Multiple integrations match: ${resolution.candidates.map((candidate) => candidate.integrationName).join(", ")}`,
        }));
        return;
      }
      setRepositoryResolutionMessages((prev) => ({ ...prev, [cloneUrl]: "No existing integration matches this repository" }));
    } catch (resolutionError) {
      setRepositoryResolutionMessages((prev) => ({
        ...prev,
        [cloneUrl]: resolutionError instanceof Error ? resolutionError.message : "Repository matching failed",
      }));
    }
  };

  const scanWorkspace = async (idx: number) => {
    const target = pushTargets[idx];
    if (!target?.integrationId || !target.repoKey || !target.cloneUrl.trim()) return;
    const cloneUrl = target.cloneUrl.trim();
    setScanningWorkspaceUrl(cloneUrl);
    setWorkspaceScanErrors((previous) => {
      const next = { ...previous };
      delete next[cloneUrl];
      return next;
    });
    try {
      const scan = await api.post<WorkspacePushTargetScanResponse>(
        "/api/admin/projects/scan-push-targets",
        {
          integrationId: target.integrationId,
          repoKey: target.repoKey,
          cloneUrl,
          ...(target.targetBranch.trim() ? { revision: target.targetBranch.trim() } : {}),
        },
      );
      const members = scan.repositories;
      setWorkspaceScans((prev) => ({
        ...prev,
        [cloneUrl]: {
          manifestFiles: scan.manifestFiles,
          members,
          diagnostics: scan.diagnostics,
        },
      }));
    } catch (scanError) {
      setWorkspaceScanErrors((previous) => ({
        ...previous,
        [cloneUrl]: scanError instanceof Error ? scanError.message : "Workspace scan failed",
      }));
    } finally {
      setScanningWorkspaceUrl((current) => current === cloneUrl ? null : current);
    }
  };

  // Unresolved members are added with whatever the scan knows; the operator then picks the repository
  // that really receives the change in the push target row, which is where a mirror gets corrected.
  const addWorkspaceMember = async (member: WorkspaceScanMember) => {
    if (pushTargets.some((target) => target.localPath === member.localPath)) return;
    const resolution = member.resolution;
    const match = resolution?.status === "matched" && resolution.match.enabled ? resolution.match : null;
    const memberKey = `${member.sourcePath}:${member.localPath}`;
    setAddingWorkspaceMember(memberKey);
    try {
      let firstBranch: string | undefined;
      if (match) {
        try {
          const response = await api.get<{ branches: string[] }>(`/api/admin/integrations/${match.integrationId}/branches?repoKey=${encodeURIComponent(match.repoKey)}`);
          firstBranch = Array.isArray(response.branches) ? response.branches[0] : undefined;
        } catch {
          // Branch discovery is best-effort; the manifest/provider fallback remains usable.
        }
      }
      const integration = match ? integrations.find((candidate) => candidate.id === match.integrationId) : undefined;
      const repository = match ? integration?.discoveredResources?.repositories?.find((candidate) => candidate.key === match.repoKey) : undefined;
      setPushTargets((prev) => prev.some((target) => target.localPath === member.localPath) ? prev : [...prev, {
        integrationId: match?.integrationId ?? "",
        repoKey: match?.repoKey ?? "",
        cloneUrl: member.cloneUrl ?? "",
        targetBranch: firstBranch ?? firstTargetBranch(member.revision, repository?.defaultBranch),
        // A fetched dependency has no place in the tree, so VE picks a free checkout directory for it.
        localPath: member.relation === "fetched"
          ? manualLocalPath(member.localPath, `repo-${prev.length + 1}`, prev, prev.length)
          : member.localPath,
        localPathMode: "fixed",
        origin: "workspace_scan",
        relation: member.relation,
        reviewerEmails: "",
      }]);
    } finally {
      setAddingWorkspaceMember((current) => current === memberKey ? null : current);
    }
  };

  const handleSave = async () => {
    if (saving) {
      return;
    }
    if (!name.trim()) { setError("Project name is required"); return; }
    if (!agentId) { setError("Select an agent"); return; }
    const abort = new AbortController();
    saveAbortRef.current = abort;
    setSaving(true);
    setError(null);
    setSaveCheckSources([]);
    try {
      const skillSources = buildSkillSourcesPayload(skillSourceRows);
      if (skillSources === null) { setError("Skill source rows require at least one skill or Install all, and SSH port must be between 1 and 65535"); setSaveCheckSources([]); return; }
      if (projectType === "coding") {
        if (!ticketSource.integrationId) { setError("Ticket source integration is required"); setSaveCheckSources([]); return; }
        if (!ticketSource.ticketProjectKey.trim()) { setError("Ticket project key is required"); setSaveCheckSources([]); return; }
        if (pushTargets.length === 0) { setError("At least one push target is required"); setSaveCheckSources([]); return; }
        setSaveCheckSources(saveCheckSourcesFromSkillSources(skillSources, "checking"));
        const payload = {
          type: "coding",
          name,
          agentId,
          postCloneScript: postCloneScript || undefined,
          skillSources,
          gerritTopicOverride: gerritTopicOverride.trim() || null,
          useFullTicketUrlInCommits,
          postReviewLinkToTicket,
          reactToCiFailures,
          ticketSource: { integrationId: ticketSource.integrationId, ticketProjectKey: ticketSource.ticketProjectKey },
          pushTargets: pushTargets.map((t, index) => ({
            integrationId: t.integrationId,
            repoKey: t.repoKey,
            cloneUrl: t.cloneUrl,
            targetBranch: t.targetBranch,
            role: legacyRoleForPushTarget(t),
            commitOrder: index + 1,
            localPath: t.localPath,
            reviewerEmails: supportsReviewerEmails(t.integrationId)
              ? t.reviewerEmails.split(",").map((e) => e.trim()).filter(Boolean)
              : [],
          })),
        };
        const vendorComponentsPayload = vendorComponents;
        if (isEditMode && project) {
          await api.put(`/api/admin/projects/${project.id}`, payload, { signal: abort.signal });
          if (vendorComponentsDirtyRef.current) {
            await api.put(`/api/admin/projects/${project.id}/vendor-components`, { components: vendorComponentsPayload }, { signal: abort.signal });
          }
        } else {
          // Created in one request so a failure rolls the project back instead of leaving it half-configured.
          await api.post<{ project: { id: string } }>("/api/admin/projects", { ...payload, vendorComponents: vendorComponentsPayload }, { signal: abort.signal });
        }
      } else {
        if (!reviewIntegrationId) { setError("Review integration is required"); setSaveCheckSources([]); return; }
        if (reviewRepoKeys.length === 0) { setError("At least one repository key is required"); setSaveCheckSources([]); return; }
        setSaveCheckSources(saveCheckSourcesFromSkillSources(skillSources, "checking"));
        const payload = {
          type: "review",
          name,
          agentId,
          postCloneScript: postCloneScript || undefined,
          skillSources,
          reviewConfig: { integrationId: reviewIntegrationId, repoKeys: reviewRepoKeys },
        };
        if (isEditMode && project) {
          await api.put(`/api/admin/projects/${project.id}`, payload, { signal: abort.signal });
        } else {
          await api.post("/api/admin/projects", payload, { signal: abort.signal });
        }
      }
      onSaved();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = e instanceof Error ? e.message : "Save failed";
      setError(message);
      setSaveCheckSources((sources) => checkedSourcesAfterError(sources, message));
    } finally {
      if (saveAbortRef.current === abort) {
        saveAbortRef.current = null;
        setSaving(false);
      }
    }
  };

  return (
    <Modal title={isEditMode ? "Edit Project" : "New Project"} onClose={onClose} width={640}>
      <FormRow>
        <Field label="Name" required>
          <FieldInput value={name} placeholder="My project" onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Type" required hint={isEditMode ? "Project type cannot be changed after creation" : undefined}>
          <FieldSelect
            value={projectType}
            disabled={isEditMode}
            onChange={(e) => { setProjectType(e.target.value as "coding" | "review"); setAgentId(""); }}
          >
            <option value="coding">Coding — ticket-driven code generation</option>
            <option value="review">Review — automated code review</option>
          </FieldSelect>
        </Field>

        <Field label="Agent" required hint={`Select an enabled ${projectType} agent`}>
          <FieldSelect value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {currentAgents.length === 0 && <option value="">— no {projectType} agents —</option>}
            {currentAgents.length > 0 && <option value="">— select —</option>}
            {currentAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </FieldSelect>
        </Field>

        {projectType === "coding" && (
          <>
            <div style={{ paddingTop: 4 }}>
              <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: 12 }}>Ticket Source</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px", background: "var(--panel-2)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-soft)" }}>
                <Field label="Ticketing Integration" required>
                  <FieldSelect value={ticketSource.integrationId} onChange={(e) => setTicketSource((prev) => ({ ...prev, integrationId: e.target.value }))}>
                    {ticketingIntegrations.length === 0 && <option value="">— no ticketing integrations —</option>}
                    {ticketingIntegrations.length > 0 && <option value="">— select —</option>}
                    {ticketingIntegrations.map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </FieldSelect>
                </Field>
                <TicketProjectKeyField
                  required
                  integrationId={ticketSource.integrationId}
                  integrations={integrations}
                  value={ticketSource.ticketProjectKey}
                  onChange={(v) => setTicketSource((prev) => ({ ...prev, ticketProjectKey: v }))}
                />
              </div>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: "13px", fontWeight: 600 }}>Push Targets ({pushTargets.length})</div>
                <button data-config-dirty className="btn ghost" style={{ fontSize: "12px", padding: "4px 10px" }} onClick={addPushTarget}>
                  <Icon name="plus" size={12} /> Add repository
                </button>
              </div>
              {pushTargets.map((t, idx) => (
                <div
                  key={idx}
                  style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", background: "var(--panel-2)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-soft)", marginBottom: 10 }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-dim)" }}>Repository #{idx + 1}</div>
                    {pushTargets.length > 1 && (
                      <button data-config-dirty className="iconbtn" onClick={() => removePushTarget(idx)}><Icon name="x" size={12} /></button>
                    )}
                  </div>
                  <Field label="VCS Integration" required>
                    <FieldSelect value={t.integrationId} onChange={(e) => updatePushTarget(idx, "integrationId", e.target.value)}>
                      {vcsIntegrations.length === 0 && <option value="">— no VCS integrations —</option>}
                      {vcsIntegrations.length > 0 && <option value="">— select —</option>}
                      {vcsIntegrations.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </FieldSelect>
                  </Field>
                  <RepositoryKeyField
                    label="Repository Key"
                    required
                    integrationId={t.integrationId}
                    integrations={integrations}
                    value={t.repoKey}
                    placeholder="repo-name"
                    onChange={(nextValue) => updatePushTargetRepoKey(idx, nextValue)}
                    onRepositorySelected={(repo) => {
                      setPushTargets((prev) => prev.map((t2, i) => i !== idx ? t2 : {
                          ...t2,
                          cloneUrl: t2.cloneUrl || (repo.cloneUrlHttp ?? repo.cloneUrlSsh ?? ""),
                          ...(t2.localPathMode === "derived"
                            ? { localPath: manualLocalPath(repo.key, `repo-${idx + 1}`, prev, idx) }
                            : {}),
                          targetBranch: (!t2.targetBranch || t2.targetBranch === "main")
                            ? (repo.defaultBranch ?? "main")
                            : t2.targetBranch,
                        }));
                    }}
                  />
                  <Field label="Clone URL" required hint={repositoryResolutionMessages[t.cloneUrl.trim()]}>
                    <FieldInput
                      value={t.cloneUrl}
                      placeholder="https://github.com/org/repo.git"
                      onChange={(e) => updatePushTarget(idx, "cloneUrl", e.target.value)}
                      onBlur={() => { void resolvePushTarget(idx); }}
                    />
                  </Field>
                  {t.localPath === "." && t.integrationId && t.repoKey && t.cloneUrl.trim() && (() => {
                    const workspaceUrl = t.cloneUrl.trim();
                    const preview = workspaceScans[workspaceUrl];
                    const workspaceScanError = workspaceScanErrors[workspaceUrl];
                    const memberQuery = workspaceScanQueries[workspaceUrl] ?? "";
                    const normalizedMemberQuery = memberQuery.trim().toLowerCase();
                    const visibleMembers = preview?.members.filter((member) =>
                      !normalizedMemberQuery || workspaceMemberSearchText(member).includes(normalizedMemberQuery)
                    ) ?? [];
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 10, borderTop: "1px solid var(--border-soft)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-dim)" }}>Workspace manifests</div>
                          <button
                            data-config-dirty
                            type="button"
                            className="btn ghost"
                            disabled={scanningWorkspaceUrl === t.cloneUrl.trim()}
                            onClick={() => { void scanWorkspace(idx); }}
                            style={{ fontSize: "12px", padding: "5px 10px" }}
                          >
                            <Icon
                              name={scanningWorkspaceUrl === t.cloneUrl.trim() ? "refresh" : preview ? "refresh" : "search"}
                              size={13}
                              {...(scanningWorkspaceUrl === t.cloneUrl.trim() ? { className: "spin" } : {})}
                            />
                            {scanningWorkspaceUrl === t.cloneUrl.trim() ? "Scanning…" : preview ? "Scan again" : "Scan workspace"}
                          </button>
                        </div>
                        {workspaceScanError && <div style={{ color: "var(--danger)", fontSize: "12px" }}>{workspaceScanError}</div>}
                        {preview && (
                          <>
                            <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)" }}>
                              {preview.manifestFiles.length} manifest{preview.manifestFiles.length === 1 ? "" : "s"} · {preview.members.length} member{preview.members.length === 1 ? "" : "s"} detected
                            </div>
                            {preview.members.length > 0 && (
                              <>
                                <div style={{ position: "relative" }}>
                                  <Icon name="search" size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-faint)", pointerEvents: "none" }} />
                                  <FieldInput
                                    type="search"
                                    aria-label="Search detected members"
                                    placeholder="Search members…"
                                    value={memberQuery}
                                    onChange={(event) => setWorkspaceScanQueries((previous) => ({ ...previous, [workspaceUrl]: event.target.value }))}
                                    style={{ padding: "6px 9px 6px 28px", fontSize: "12px" }}
                                  />
                                </div>
                                {visibleMembers.length > 0 ? (
                                  <div
                                    data-testid="workspace-members-scroll"
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: WORKSPACE_MEMBER_GAP,
                                      maxHeight: WORKSPACE_MEMBER_LIST_MAX_HEIGHT,
                                      overflowY: "auto",
                                      paddingRight: 3,
                                    }}
                                  >
                                {visibleMembers.map((member) => {
                                  const resolution = member.resolution;
                                  const state = member.cloneUrl === null
                                    ? "in-repo layer"
                                    : resolution?.status === "matched"
                                      ? resolution.match.enabled ? `matched · ${resolution.match.integrationName}` : `disabled · ${resolution.match.integrationName}`
                                      : resolution?.status ?? "unmatched";
                                      const memberKey = `${member.sourcePath}:${member.localPath}`;
                                      const isAdded = pushTargets.some((target) => target.localPath === member.localPath);
                                      const isMatched = resolution?.status === "matched" && resolution.match.enabled;
                                      const isTracked = vendorComponents.some((component) => vendorComponentKey(component) === vendorComponentKey(member));
                                  return (
                                    <div key={`${member.sourcePath}:${member.localPath}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", minHeight: WORKSPACE_MEMBER_ROW_HEIGHT, boxSizing: "border-box", padding: "7px 9px", background: "var(--panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)" }}>
                                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                          <span className="mono" style={{ fontSize: "11.5px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.localPath}</span>
                                          <Tag tone={VENDOR_ORIGIN_TONES[member.origin]}>{VENDOR_ORIGIN_LABELS[member.origin]}</Tag>
                                        </div>
                                        <div className="mono" style={{ fontSize: "10px", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          {member.sourcePath} · {member.relation}
                                        </div>
                                      </div>
                                      {member.origin === "internal" ? (
                                        <Tag tone="muted">{state}</Tag>
                                      ) : isTracked ? (
                                        <Tag tone="warn">patched locally</Tag>
                                      ) : (
                                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                          {!isAdded && (member.origin === "patch_required" || member.origin === "ambiguous") && (
                                            <button
                                              type="button"
                                              className="iconbtn"
                                              title="No repository of ours owns this — the agent patches it in place"
                                              aria-label={`Patch ${vendorComponentName(member)} locally`}
                                              onClick={() => trackVendorComponent(member)}
                                            >
                                              <Icon name="edit" size={12} />
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            className="btn sm"
                                            aria-label={isAdded ? `${member.localPath} added` : `Add ${member.localPath} as push target`}
                                            disabled={isAdded || addingWorkspaceMember === memberKey}
                                            onClick={() => { void addWorkspaceMember(member); }}
                                          >
                                            <Icon name={isAdded ? "check" : "plus"} size={12} />
                                            {isAdded ? "Added" : isMatched ? state : "Add"}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                                  </div>
                                ) : (
                                  <div style={{ padding: "10px 7px", fontSize: "11.5px", color: "var(--text-faint)" }}>No detected members match this search.</div>
                                )}
                              </>
                            )}
                            {preview.diagnostics.map((diagnostic, diagnosticIdx) => (
                              <div key={`${diagnostic.sourcePath}:${diagnosticIdx}`} style={{ fontSize: "11.5px", color: diagnostic.severity === "error" ? "var(--danger)" : "var(--text-ghost)" }}>
                                {diagnostic.sourcePath}: {diagnostic.message}
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })()}
                  <TargetBranchField
                    integrationId={t.integrationId}
                    repoKey={t.repoKey}
                    value={t.targetBranch}
                    onChange={(v) => updatePushTarget(idx, "targetBranch", v)}
                  />
                  {supportsReviewerEmails(t.integrationId) && (
                    <Field label="Reviewer Emails" hint="Up to 20 comma-separated emails. Gerrit adds them directly; GitLab matches visible profile emails.">
                      <FieldInput value={t.reviewerEmails} placeholder="alice@example.com, bob@example.com" onChange={(e) => updatePushTarget(idx, "reviewerEmails", e.target.value)} />
                    </Field>
                  )}
                </div>
              ))}
            </div>

            {vendorComponents.length > 0 && (
              <Field
                label="Vendor Components"
                hint="Components the scan found that no repository of ours owns. The agent is told not to edit them and to patch them in place instead — through a .bbappend or the contrib rules."
              >
                <div data-testid="vendor-components" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {vendorComponents.map((component) => (
                    <div key={vendorComponentKey(component)} className="card" style={{ padding: "8px 11px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "11.5px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {vendorComponentName(component)}
                        {component.localPath && component.localPath !== component.sourcePath && (
                          <span style={{ color: "var(--text-dim)" }}> · {component.sourcePath}</span>
                        )}
                      </span>
                      <Tag tone={VENDOR_ORIGIN_TONES[component.origin]}>{VENDOR_ORIGIN_LABELS[component.origin]}</Tag>
                      <button
                        type="button"
                        className="iconbtn danger"
                        aria-label={`Remove vendor component ${vendorComponentName(component)}`}
                        onClick={() => removeVendorComponent(vendorComponentKey(component))}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </Field>
            )}

            <Field label="Custom Gerrit Topic" hint="Overrides the ticket-derived topic (e.g. VE-<taskId>-<ticket-title>) for all changes pushed from this project. Leave blank to keep the default per-ticket topic.">
              <FieldInput
                value={gerritTopicOverride}
                placeholder="my-custom-topic"
                onChange={(e) => setGerritTopicOverride(e.target.value)}
              />
            </Field>

            <Field
              label="Ticket URL in Commits"
              hint="When enabled, agent commit messages include the full ticket URL instead of the short #id form."
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={useFullTicketUrlInCommits}
                  onChange={(e) => setUseFullTicketUrlInCommits(e.target.checked)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                />
                <span>Include full ticket URL in commit message footers</span>
              </label>
            </Field>

            <Field
              label="Post Review Link to Ticket"
              hint="When enabled, VE adds a note on the source ticket with the Gerrit/review URL(s) once the first cycle opens a review. Off by default — most teams already surface this via standard VCS/ticket integrations."
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={postReviewLinkToTicket}
                  onChange={(e) => setPostReviewLinkToTicket(e.target.checked)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                />
                <span>Post a ticket comment with the review link(s)</span>
              </label>
            </Field>

            <Field
              label="React to CI Failures"
              hint="When enabled, CI build-failure notifications (e.g. Jenkins 'Build Failed') count as actionable review feedback and trigger a retry cycle. Off by default — some teams don't want VE auto-retrying on broken CI."
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={reactToCiFailures}
                  onChange={(e) => setReactToCiFailures(e.target.checked)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                />
                <span>Retry a cycle when CI reports a build failure</span>
              </label>
            </Field>
          </>
        )}

        {projectType === "review" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px", background: "var(--panel-2)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-soft)" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: 2 }}>Review Configuration</div>
            <Field label="Review Integration" required>
              <FieldSelect value={reviewIntegrationId} onChange={(e) => setReviewIntegrationId(e.target.value)}>
                {reviewIntegrations.length === 0 && <option value="">— no review integrations —</option>}
                {reviewIntegrations.length > 0 && <option value="">— select —</option>}
                {reviewIntegrations.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </FieldSelect>
            </Field>
            <RepositoryKeysField
              label="Repository Keys"
              required
              integrationId={reviewIntegrationId}
              integrations={integrations}
              value={reviewRepoKeys}
              onChange={setReviewRepoKeys}
              hint="Select repository keys after discovery"
            />
          </div>
        )}

        <ProjectSkillSourcesField
          rows={skillSourceRows}
          setRows={setSkillSourceRows}
          projectId={project?.id}
        />

        <Field label="Post-Clone Script" hint="Optional shell script to run after repo clone (before agent runs)">
          <FieldTextarea
            value={postCloneScript}
            placeholder="#!/bin/sh&#10;npm install"
            onChange={(e) => setPostCloneScript(e.target.value)}
            style={{ minHeight: "80px", fontFamily: "var(--font-mono)" }}
          />
        </Field>

        {saveCheckSources.length > 0 && (
          <div style={{ padding: "10px 14px", background: "var(--panel-2)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)", fontSize: "12.5px", color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 600, color: "var(--text)" }}>External skill source check</div>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)" }}>
                {saving ? "running" : "last attempt"}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "90px minmax(0, 1fr) 120px 80px", gap: "6px 10px", alignItems: "start" }}>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)", textTransform: "uppercase" }}>Status</div>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)", textTransform: "uppercase" }}>Source</div>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)", textTransform: "uppercase" }}>SSH user</div>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)", textTransform: "uppercase" }}>Port</div>
              {saveCheckSources.map((source, index) => (
                <div key={`${index}:${source.source}`} style={{ display: "contents" }}>
                  <div className="mono" style={{ fontSize: "11.5px", color: source.status === "failed" ? "var(--danger)" : source.status === "checked" ? "var(--accent)" : "var(--text-faint)" }}>
                    {saveCheckStatusLabel(source.status)}
                  </div>
                  <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", overflowWrap: "anywhere", minWidth: 0 }}>
                    #{index + 1} {source.source}
                  </div>
                  <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", overflowWrap: "anywhere" }}>
                    {source.sshUser ?? "—"}
                  </div>
                  <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>
                    {source.sshPort ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : (isEditMode ? "Save changes" : "Create project")}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
