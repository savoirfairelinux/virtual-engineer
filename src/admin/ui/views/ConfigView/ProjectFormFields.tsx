import { useEffect, useMemo, useRef, useState } from "react";
import { Field, FieldInput } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import type { ApiIntegration } from "../../types.ts";
import { useBranchOptions, useRepositoryOptions, useTicketProjectOptions } from "./projectFormDiscoveryHooks.ts";
import { repositoryLabel, type RepositoryOption } from "./projectFormTypes.ts";

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

export function TargetBranchField({
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

export function RepositoryKeyField({
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

export function TicketProjectKeyField({
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

export function RepositoryKeysField({
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
