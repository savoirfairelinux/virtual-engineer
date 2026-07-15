import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import type { ApiAgent, ApiIntegration } from "../../types.ts";

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
  skillDiscoveryEnabled?: boolean;
  gerritTopicOverride?: string | null;
  useFullTicketUrlInCommits?: boolean;
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
  }>;
}

interface TicketSource {
  integrationId: string;
  ticketProjectKey: string;
}

interface PushTarget {
  integrationId: string;
  repoKey: string;
  cloneUrl: string;
  targetBranch: string;
  role: "primary" | "submodule" | "dependency" | "related";
  commitOrder: string;
  localPath: string;
}

interface RepositoryOption {
  key: string;
  name: string;
  cloneUrlSsh?: string;
  cloneUrlHttp?: string;
  defaultBranch?: string;
  webUrl?: string;
}

interface TicketProjectOption {
  key: string;
  name: string;
  url?: string;
}

function emptyPushTarget(order = 1): PushTarget {
  return { integrationId: "", repoKey: "", cloneUrl: "", targetBranch: "main", role: "primary", commitOrder: String(order), localPath: "." };
}

function normalizeRepository(option: RepositoryOption | string | null | undefined): RepositoryOption | null {
  if (!option) return null;
  if (typeof option === "string") {
    return { key: option, name: option };
  }
  if (typeof option.key !== "string" || !option.key || typeof option.name !== "string" || !option.name) {
    return null;
  }
  return option;
}

function repositoryLabel(repo: RepositoryOption): string {
  const extra = [repo.defaultBranch, repo.webUrl].filter((v) => typeof v === "string" && v.length > 0) as string[];
  return extra.length > 0 ? `${repo.name} · ${extra[0]}` : repo.name;
}

function normalizeTicketProject(item: TicketProjectOption | string | null | undefined): TicketProjectOption | null {
  if (!item) return null;
  if (typeof item === "string") return { key: item, name: item };
  if (typeof item.key !== "string" || !item.key) return null;
  return { key: item.key, name: (item.name && item.name.length > 0) ? item.name : item.key, ...(item.url ? { url: item.url } : {}) };
}

function useTicketProjectOptions(integrationId: string, integrations: ApiIntegration[]) {
  const [ticketProjects, setTicketProjects] = useState<TicketProjectOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId) { setTicketProjects([]); setLoading(false); return; }
    const integration = integrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.ticketProjects;
    if (Array.isArray(cached) && cached.length > 0) {
      setTicketProjects(cached.map(normalizeTicketProject).filter((p): p is TicketProjectOption => p !== null));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.post(`/api/admin/integrations/${integrationId}/discover`, {})
      .then(() => api.get<{ integration: ApiIntegration }>(`/api/admin/integrations/${integrationId}`))
      .then((res) => {
        if (cancelled) return;
        const discovered = res.integration.discoveredResources?.ticketProjects ?? [];
        setTicketProjects(
          Array.isArray(discovered)
            ? discovered.map(normalizeTicketProject).filter((p): p is TicketProjectOption => p !== null)
            : []
        );
      })
      .catch(() => { if (!cancelled) setTicketProjects([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [integrationId, integrations]);

  return { ticketProjects, loading };
}

function useRepositoryOptions(integrationId: string, integrations: ApiIntegration[]) {
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId) {
      setRepositories([]);
      setLoading(false);
      return;
    }

    const integration = integrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.repositories;
    if (Array.isArray(cached) && cached.length > 0) {
      setRepositories(cached.map((item) => normalizeRepository(item)).filter((item): item is RepositoryOption => item !== null));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api.post(`/api/admin/integrations/${integrationId}/discover`, {})
      .then(() => api.get<{ integration: ApiIntegration }>(`/api/admin/integrations/${integrationId}`))
      .then((res) => {
        if (cancelled) return;
        const discovered = res.integration.discoveredResources?.repositories ?? [];
        const normalized = Array.isArray(discovered)
          ? discovered.map((item) => normalizeRepository(item)).filter((item): item is RepositoryOption => item !== null)
          : [];
        setRepositories(normalized);
      })
      .catch(() => {
        if (!cancelled) setRepositories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [integrationId, integrations]);

  return { repositories, loading };
}

interface SelectOption {
  value: string;
  label: string;
  meta?: string;
}

/**
 * Single-select dropdown menu with a search box. Collapsed by default (shows
 * the current selection like a native <select>); clicking it drops down a
 * panel containing a search field and a filterable, clickable list. When no
 * options are available it falls back to a free-text input so manual entry
 * still works.
 */
function SearchableSelect({
  options,
  value,
  onChange,
  onFreeText,
  loading,
  disabled,
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  freeTextPlaceholder,
  placeholderLabel = "— select —",
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  onFreeText?: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  freeTextPlaceholder?: string;
  placeholderLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (options.length === 0) {
    return (
      <FieldInput
        value={value}
        placeholder={loading ? "Loading…" : (freeTextPlaceholder ?? "")}
        disabled={loading || disabled}
        onChange={(e) => (onFreeText ?? onChange)(e.target.value)}
      />
    );
  }

  const normalized = search.trim().toLowerCase();
  const filtered = normalized.length > 0
    ? options.filter((o) =>
      o.value.toLowerCase().includes(normalized)
      || o.label.toLowerCase().includes(normalized)
      || (o.meta ? o.meta.toLowerCase().includes(normalized) : false))
    : options;

  const selectedOption = options.find((o) => o.value === value) ?? null;
  const triggerText = loading
    ? "Loading…"
    : selectedOption
    ? selectedOption.label
    : (value || placeholderLabel);
  const isPlaceholder = !loading && !selectedOption && !value;

  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    setSearch("");
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={loading || disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          padding: "8px 11px", fontSize: "13.5px", fontFamily: "var(--font-sans)",
          border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
          borderRadius: "var(--radius-sm)", background: "var(--panel-2)",
          color: isPlaceholder ? "var(--text-ghost)" : "var(--text)",
          textAlign: "left", width: "100%", cursor: (loading || disabled) ? "default" : "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{triggerText}</span>
        <Icon name="chevdown" size={14} style={{ flexShrink: 0, opacity: 0.7, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s var(--ease)" }} />
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, padding: "8px", background: "var(--panel-2)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)" }}>
          <FieldInput
            autoFocus
            value={search}
            placeholder={searchPlaceholder}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 220, overflowY: "auto" }}>
            {filtered.map((o) => {
              const sel = o.value === value;
              return (
                <button
                  type="button"
                  key={o.value}
                  onClick={() => select(o.value)}
                  style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer", fontSize: "13px", padding: "6px 7px", borderRadius: "var(--radius-sm)", background: sel ? "var(--accent-soft)" : "transparent", border: "none", color: "inherit", width: "100%" }}
                >
                  <Icon name="check" size={13} style={{ flexShrink: 0, opacity: sel ? 1 : 0, color: "var(--accent)" }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                  {o.meta && <span className="mono" style={{ fontSize: "10px", color: "var(--text-faint)", flexShrink: 0 }}>{o.meta}</span>}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: "8px 6px", color: "var(--text-faint)", fontSize: "12px" }}>{emptyMessage}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Lazily fetch the branches of a repository for a given integration + repoKey. */
function useBranchOptions(integrationId: string, repoKey: string) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!integrationId || !repoKey) { setBranches([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get<{ branches: string[] }>(`/api/admin/integrations/${integrationId}/branches?repoKey=${encodeURIComponent(repoKey)}`)
      .then((res) => { if (!cancelled) setBranches(Array.isArray(res.branches) ? res.branches : []); })
      .catch(() => { if (!cancelled) setBranches([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [integrationId, repoKey]);

  return { branches, loading };
}

function TargetBranchField({
  integrationId,
  repoKey,
  value,
  onChange,
}: {
  integrationId: string;
  repoKey: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { branches, loading } = useBranchOptions(integrationId, repoKey);
  const options = useMemo<SelectOption[]>(() => branches.map((b) => ({ value: b, label: b })), [branches]);

  const hint = loading
    ? "Loading branches…"
    : branches.length > 0
    ? `${branches.length} branch${branches.length === 1 ? "" : "es"} found`
    : "Enter the target branch (discovery unavailable)";

  return (
    <Field label="Target Branch" required hint={hint}>
      <SearchableSelect
        options={options}
        value={value}
        onChange={onChange}
        onFreeText={onChange}
        loading={loading}
        searchPlaceholder="Search branches…"
        freeTextPlaceholder="main"
        emptyMessage="No branches match this search."
      />
    </Field>
  );
}

function RepositoryKeyField({
  label,
  hint,
  integrationId,
  integrations,
  value,
  onChange,
  onRepositorySelected,
  required,
  placeholder,
}: {
  label: string;
  hint?: string;
  integrationId: string;
  integrations: ApiIntegration[];
  value: string;
  onChange: (nextValue: string) => void;
  onRepositorySelected?: (repo: RepositoryOption) => void;
  required?: boolean;
  placeholder: string;
}) {
  const { repositories, loading } = useRepositoryOptions(integrationId, integrations);
  const selected = useMemo(() => repositories.find((repo) => repo.key === value) ?? null, [repositories, value]);

  useEffect(() => {
    if (repositories.length > 0 && value && !selected) {
      onChange("");
    }
  }, [onChange, repositories, selected, value]);

  const handleSelect = (key: string) => {
    onChange(key);
    if (key && onRepositorySelected) {
      const repo = repositories.find((r) => r.key === key);
      if (repo) onRepositorySelected(repo);
    }
  };

  const defaultHint = repositories.length > 0
    ? "Select a repository — clone URL and branch will be filled automatically"
    : loading ? undefined : "Enter repository key manually (run discover first to get a list)";

  const options = useMemo<SelectOption[]>(
    () => repositories.map((repo) => ({ value: repo.key, label: repositoryLabel(repo), meta: repo.key })),
    [repositories]
  );

  return (
    <Field label={label} required={required} hint={hint ?? defaultHint}>
      <SearchableSelect
        options={options}
        value={value}
        onChange={handleSelect}
        onFreeText={onChange}
        loading={loading}
        searchPlaceholder="Search repositories by name or key"
        freeTextPlaceholder={placeholder}
        emptyMessage="No repositories match this search."
      />
    </Field>
  );
}

function TicketProjectKeyField({
  integrationId,
  integrations,
  value,
  onChange,
  required,
}: {
  integrationId: string;
  integrations: ApiIntegration[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const { ticketProjects, loading } = useTicketProjectOptions(integrationId, integrations);
  const selected = useMemo(() => ticketProjects.find((p) => p.key === value) ?? null, [ticketProjects, value]);
  useEffect(() => {
    if (ticketProjects.length > 0 && value && !selected) onChange("");
  }, [onChange, ticketProjects, selected, value]);

  const hint = loading
    ? "Loading projects…"
    : ticketProjects.length > 0
    ? `${ticketProjects.length} project${ticketProjects.length === 1 ? "" : "s"} found`
    : "e.g. project identifier in Redmine / GitLab group or project path";

  const options = useMemo<SelectOption[]>(
    () => ticketProjects.map((p) => ({
      value: p.key,
      label: p.name !== p.key ? p.name : p.key,
      ...(p.name !== p.key ? { meta: p.key } : {}),
    })),
    [ticketProjects]
  );

  return (
    <Field label="Ticket Project Key" required={required} hint={hint}>
      <SearchableSelect
        options={options}
        value={value}
        onChange={onChange}
        onFreeText={onChange}
        loading={loading}
        searchPlaceholder="Search projects by name or key"
        freeTextPlaceholder="PROJECT_KEY"
        emptyMessage="No projects match this search."
      />
    </Field>
  );
}

function RepositoryKeysField({
  label,
  hint,
  integrationId,
  integrations,
  value,
  onChange,
  required,
}: {
  label: string;
  hint?: string;
  integrationId: string;
  integrations: ApiIntegration[];
  value: string[];
  onChange: (nextValue: string[]) => void;
  required?: boolean;
}) {
  const { repositories, loading } = useRepositoryOptions(integrationId, integrations);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (repositories.length > 0) {
      const next = value.filter((key) => repositories.some((repo) => repo.key === key));
      if (next.length !== value.length) onChange(next);
    }
  }, [onChange, repositories, value]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredRepositories = normalizedSearch.length > 0
    ? repositories.filter((repo) => {
      const label = repositoryLabel(repo).toLowerCase();
      return repo.key.toLowerCase().includes(normalizedSearch) || label.includes(normalizedSearch);
    })
    : repositories;

  const filteredKeys = filteredRepositories.map((repo) => repo.key);
  const selectedFilteredCount = filteredKeys.filter((key) => value.includes(key)).length;

  const selectAllFiltered = () => {
    const next = new Set(value);
    for (const key of filteredKeys) next.add(key);
    onChange(Array.from(next));
  };

  const unselectAllFiltered = () => {
    if (filteredKeys.length === 0) return;
    onChange(value.filter((key) => !filteredKeys.includes(key)));
  };

  return (
    <Field label={label} required={required} hint={hint ?? (repositories.length > 0 ? `${value.length} of ${repositories.length} selected` : "Enter repository keys manually if discovery is unavailable")}>
      {repositories.length > 0 ? (
        <div ref={containerRef} style={{ position: "relative" }}>
          <button
            type="button"
            disabled={loading}
            onClick={() => setOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              padding: "8px 11px", fontSize: "13.5px", fontFamily: "var(--font-sans)",
              border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius-sm)", background: "var(--panel-2)",
              color: value.length > 0 ? "var(--text)" : "var(--text-ghost)",
              textAlign: "left", width: "100%", cursor: loading ? "default" : "pointer",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {loading ? "Loading…" : value.length > 0 ? `${value.length} repositor${value.length === 1 ? "y" : "ies"} selected` : "— select repositories —"}
            </span>
            <Icon name="chevdown" size={14} style={{ flexShrink: 0, opacity: 0.7, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s var(--ease)" }} />
          </button>

          {open && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, padding: "8px", background: "var(--panel-2)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FieldInput
              autoFocus
              value={search}
              placeholder="Search repositories by name or key"
              onChange={(e) => setSearch(e.target.value)}
              disabled={loading}
            />
            <button
              type="button"
              className="btn ghost"
              onClick={selectAllFiltered}
              disabled={loading || filteredKeys.length === 0 || selectedFilteredCount === filteredKeys.length}
              style={{ whiteSpace: "nowrap", fontSize: "11px", padding: "6px 10px" }}
            >
              Select all
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={unselectAllFiltered}
              disabled={loading || selectedFilteredCount === 0}
              style={{ whiteSpace: "nowrap", fontSize: "11px", padding: "6px 10px" }}
            >
              Unselect all
            </button>
          </div>

          <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)" }}>
            {filteredRepositories.length} visible · {selectedFilteredCount} selected
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 240, overflowY: "auto", padding: "6px 8px", background: "var(--panel)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-soft)" }}>
            {filteredRepositories.map((repo) => {
            const checked = value.includes(repo.key);
            return (
              <label
                key={repo.key}
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: loading ? "default" : "pointer", fontSize: "13px", padding: "5px 6px", borderRadius: "var(--radius-sm)", background: checked ? "var(--accent-soft)" : "transparent", userSelect: "none" }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={loading}
                  onChange={(e) => onChange(e.target.checked ? [...value, repo.key] : value.filter((k) => k !== repo.key))}
                  style={{ accentColor: "var(--accent)", cursor: loading ? "default" : "pointer", flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {repositoryLabel(repo)}
                </span>
                <span className="mono" style={{ fontSize: "10px", color: "var(--text-faint)", flexShrink: 0 }}>{repo.key}</span>
              </label>
            );
            })}
            {filteredRepositories.length === 0 && (
              <div style={{ padding: "8px 6px", color: "var(--text-faint)", fontSize: "12px" }}>
                No repositories match this search.
              </div>
            )}
          </div>
          </div>
          )}
        </div>
      ) : (
        <FieldInput
          value={value.join(", ")}
          placeholder={loading ? "Loading repositories…" : "repo-a, repo-b"}
          onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          disabled={loading}
        />
      )}
    </Field>
  );
}

export function ProjectFormModal({ agents, integrations, project, onClose, onSaved }: Props) {
  const isEditMode = project !== undefined;
  const [projectType, setProjectType] = useState<"coding" | "review">(project?.type ?? "coding");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [postCloneScript, setPostCloneScript] = useState("");
  const [skillDiscoveryEnabled, setSkillDiscoveryEnabled] = useState(false);
  const [gerritTopicOverride, setGerritTopicOverride] = useState("");
  const [useFullTicketUrlInCommits, setUseFullTicketUrlInCommits] = useState(false);

  // Coding-specific
  const [ticketSource, setTicketSource] = useState<TicketSource>({ integrationId: "", ticketProjectKey: "" });
  const [pushTargets, setPushTargets] = useState<PushTarget[]>([emptyPushTarget(1)]);

  // Review-specific
  const [reviewIntegrationId, setReviewIntegrationId] = useState("");
  const [reviewRepoKeys, setReviewRepoKeys] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setProjectType(project.type);
    setName(project.name);
    setAgentId(project.agentId ?? "");
    setPostCloneScript(project.postCloneScript ?? "");
    setSkillDiscoveryEnabled(project.skillDiscoveryEnabled ?? false);
    setGerritTopicOverride(project.gerritTopicOverride ?? "");
    setUseFullTicketUrlInCommits(project.useFullTicketUrlInCommits ?? false);

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
        role: t.role,
        commitOrder: String(t.commitOrder),
        localPath: t.localPath,
      }));
      setPushTargets(nextTargets.length > 0 ? nextTargets : [emptyPushTarget(1)]);
    } else {
      setReviewIntegrationId(project.reviewConfig?.integration?.id ?? "");
      setReviewRepoKeys(project.reviewConfig?.repos ?? []);
    }
  }, [project]);

  const codingAgents = agents.filter((a) => a.type === "coding");
  const reviewAgents = agents.filter((a) => a.type === "review");
  const currentAgents = projectType === "coding" ? codingAgents : reviewAgents;

  const ticketingIntegrations = integrations.filter((i) => i.domainCapabilities.includes("issue_tracking"));
  const vcsIntegrations = integrations.filter((i) => i.domainCapabilities.includes("source_control"));
  const reviewIntegrations = integrations.filter((i) => i.domainCapabilities.includes("code_review"));

  const updatePushTarget = (idx: number, key: keyof PushTarget, val: string) => {
    setPushTargets((prev) => prev.map((t, i) => i === idx ? { ...t, [key]: val } : t));
  };

  const addPushTarget = () => {
    setPushTargets((prev) => [...prev, emptyPushTarget(prev.length + 1)]);
  };

  const removePushTarget = (idx: number) => {
    setPushTargets((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Project name is required"); return; }
    if (!agentId) { setError("Select an agent"); return; }
    setSaving(true);
    setError(null);
    try {
      if (projectType === "coding") {
        if (!ticketSource.integrationId) { setError("Ticket source integration is required"); setSaving(false); return; }
        if (!ticketSource.ticketProjectKey.trim()) { setError("Ticket project key is required"); setSaving(false); return; }
        if (pushTargets.length === 0) { setError("At least one push target is required"); setSaving(false); return; }
        const payload = {
          type: "coding",
          name,
          agentId,
          postCloneScript: postCloneScript || undefined,
          skillDiscoveryEnabled,
          gerritTopicOverride: gerritTopicOverride.trim() || null,
          useFullTicketUrlInCommits,
          ticketSource: { integrationId: ticketSource.integrationId, ticketProjectKey: ticketSource.ticketProjectKey },
          pushTargets: pushTargets.map((t) => ({
            integrationId: t.integrationId,
            repoKey: t.repoKey,
            cloneUrl: t.cloneUrl,
            targetBranch: t.targetBranch,
            role: t.role,
            commitOrder: parseInt(t.commitOrder, 10) || 1,
            localPath: t.localPath,
          })),
        };
        if (isEditMode && project) {
          await api.put(`/api/admin/projects/${project.id}`, payload);
        } else {
          await api.post("/api/admin/projects", payload);
        }
      } else {
        if (!reviewIntegrationId) { setError("Review integration is required"); setSaving(false); return; }
        if (reviewRepoKeys.length === 0) { setError("At least one repository key is required"); setSaving(false); return; }
        const payload = {
          type: "review",
          name,
          agentId,
          postCloneScript: postCloneScript || undefined,
          skillDiscoveryEnabled,
          reviewConfig: { integrationId: reviewIntegrationId, repoKeys: reviewRepoKeys },
        };
        if (isEditMode && project) {
          await api.put(`/api/admin/projects/${project.id}`, payload);
        } else {
          await api.post("/api/admin/projects", payload);
        }
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
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
                <button className="btn ghost" style={{ fontSize: "12px", padding: "4px 10px" }} onClick={addPushTarget}>
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
                      <button className="iconbtn" onClick={() => removePushTarget(idx)}><Icon name="x" size={12} /></button>
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
                    onChange={(nextValue) => updatePushTarget(idx, "repoKey", nextValue)}
                    onRepositorySelected={(repo) => {
                      setPushTargets((prev) => prev.map((t2, i) => i !== idx ? t2 : {
                        ...t2,
                        cloneUrl: t2.cloneUrl || (repo.cloneUrlHttp ?? repo.cloneUrlSsh ?? ""),
                        targetBranch: (!t2.targetBranch || t2.targetBranch === "main")
                          ? (repo.defaultBranch ?? "main")
                          : t2.targetBranch,
                      }));
                    }}
                  />
                  <Field label="Clone URL" required>
                    <FieldInput value={t.cloneUrl} placeholder="https://github.com/org/repo.git" onChange={(e) => updatePushTarget(idx, "cloneUrl", e.target.value)} />
                  </Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <TargetBranchField
                      integrationId={t.integrationId}
                      repoKey={t.repoKey}
                      value={t.targetBranch}
                      onChange={(v) => updatePushTarget(idx, "targetBranch", v)}
                    />
                    <Field label="Local Path" required hint={`"." for root`}>
                      <FieldInput value={t.localPath} placeholder="." onChange={(e) => updatePushTarget(idx, "localPath", e.target.value)} />
                    </Field>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Role">
                      <FieldSelect value={t.role} onChange={(e) => updatePushTarget(idx, "role", e.target.value)}>
                        <option value="primary">Primary</option>
                        <option value="submodule">Submodule</option>
                        <option value="dependency">Dependency</option>
                        <option value="related">Related</option>
                      </FieldSelect>
                    </Field>
                    <Field label="Commit Order">
                      <FieldInput type="number" min={1} value={t.commitOrder} onChange={(e) => updatePushTarget(idx, "commitOrder", e.target.value)} />
                    </Field>
                  </div>
                </div>
              ))}
            </div>

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

        <Field label="Post-Clone Script" hint="Optional shell script to run after repo clone (before agent runs)">
          <FieldTextarea
            value={postCloneScript}
            placeholder="#!/bin/sh&#10;npm install"
            onChange={(e) => setPostCloneScript(e.target.value)}
            style={{ minHeight: "80px", fontFamily: "var(--font-mono)" }}
          />
        </Field>

        {(
          <Field
            label="Skill Discovery"
            hint="When enabled, the agent loads team-defined skills from <repo>/.github/skills. Only enable for trusted repositories."
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={skillDiscoveryEnabled}
                onChange={(e) => setSkillDiscoveryEnabled(e.target.checked)}
                style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
              />
              <span>Load repository skills from <code>.github/skills</code></span>
            </label>
          </Field>
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
