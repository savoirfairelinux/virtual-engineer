import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api.ts";
import { Field, FieldInput } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";

export interface SkillSource {
  source: string;
  skills: string[];
  installAll?: boolean;
  sshUser?: string;
  sshPort?: number;
  sshKeyPath?: string;
  sshKnownHostsPath?: string;
}

export interface SkillSourceRow {
  id: string;
  source: string;
  skillsText: string;
  installAll: boolean;
  sshUser: string;
  sshPort: string;
  sshKeyPath: string;
  sshKnownHostsPath: string;
  availableSkills: string[];
  listing: boolean;
  listError: string | null;
}

const MAX_TCP_PORT = 65_535;

function newSkillSourceRowId(): string {
  return crypto.randomUUID();
}

export function emptySkillSourceRow(): SkillSourceRow {
  return { id: newSkillSourceRowId(), source: "", skillsText: "", installAll: false, sshUser: "", sshPort: "", sshKeyPath: "", sshKnownHostsPath: "", availableSkills: [], listing: false, listError: null };
}

export function skillSourceToRow(source: SkillSource): SkillSourceRow {
  return {
    id: newSkillSourceRowId(),
    source: source.source,
    skillsText: source.skills.join(", "),
    installAll: source.installAll === true,
    sshUser: source.sshUser ?? "",
    sshPort: source.sshPort !== undefined ? String(source.sshPort) : "",
    sshKeyPath: source.sshKeyPath ?? "",
    sshKnownHostsPath: source.sshKnownHostsPath ?? "",
    availableSkills: [],
    listing: false,
    listError: null,
  };
}

export function preloadedProjectSkillSourceRow(): SkillSourceRow {
  return skillSourceToRow({
    source: "ssh://g1.sfl.io/sfl/agent-skills",
    skills: [],
    installAll: true,
    sshPort: 29419,
  });
}

function isSshSkillSource(source: string): boolean {
  const normalized = source.trimStart().toLowerCase();
  return normalized.startsWith("ssh://") || normalized.startsWith("git@");
}

function rowToSkillSource(row: SkillSourceRow): SkillSource | null {
  const source = row.source.trim();
  if (!source) return null;
  const sshPort = row.sshPort.trim() ? Number(row.sshPort.trim()) : undefined;
  const ssh = {
    ...(row.sshUser.trim() ? { sshUser: row.sshUser.trim() } : {}),
    ...(Number.isInteger(sshPort) && sshPort !== undefined ? { sshPort } : {}),
    ...(row.sshKeyPath.trim() ? { sshKeyPath: row.sshKeyPath.trim() } : {}),
    ...(row.sshKnownHostsPath.trim() ? { sshKnownHostsPath: row.sshKnownHostsPath.trim() } : {}),
  };
  if (row.installAll) return { source, skills: [], installAll: true, ...ssh };
  const skills = Array.from(new Set(row.skillsText.split(",").map((s) => s.trim()).filter(Boolean)));
  return skills.length > 0 ? { source, skills, ...ssh } : null;
}

function selectedSkillSet(row: SkillSourceRow): Set<string> {
  return new Set(row.skillsText.split(",").map((s) => s.trim()).filter(Boolean));
}

function skillsTextFromSet(skills: Set<string>): string {
  return Array.from(skills).join(", ");
}

export function buildSkillSourcesPayload(rows: SkillSourceRow[]): SkillSource[] | null {
  const sources = rows.map(rowToSkillSource).filter((source): source is SkillSource => source !== null);
  const invalidRow = rows.some((row) => row.source.trim() && !row.installAll && row.skillsText.split(",").map((s) => s.trim()).filter(Boolean).length === 0);
  const invalidSshPort = rows.some((row) => row.sshPort.trim() && (!Number.isInteger(Number(row.sshPort.trim())) || Number(row.sshPort.trim()) <= 0 || Number(row.sshPort.trim()) > MAX_TCP_PORT));
  if (invalidRow) return null;
  if (invalidSshPort) return null;
  return sources;
}

export function ProjectSkillSourcesField({
  enabled,
  onEnabledChange,
  localSkillsPath,
  onLocalSkillsPathChange,
  rows,
  setRows,
  projectId,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  localSkillsPath: string;
  onLocalSkillsPathChange: (path: string) => void;
  rows: SkillSourceRow[];
  setRows: Dispatch<SetStateAction<SkillSourceRow[]>>;
  projectId?: string | undefined;
}) {
  const updateRow = (id: string, patch: Partial<SkillSourceRow>) => {
    setRows((prev) => prev.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const listRowSkills = async (id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row?.source.trim()) {
      updateRow(id, { listError: "Skill source is required" });
      return;
    }
    const sshPort = row.sshPort.trim() ? Number(row.sshPort.trim()) : undefined;
    if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > MAX_TCP_PORT)) {
      updateRow(id, { listError: "SSH port must be between 1 and 65535" });
      return;
    }
    updateRow(id, { listing: true, listError: null, availableSkills: [] });
    try {
      const path = projectId
        ? `/api/admin/projects/${encodeURIComponent(projectId)}/skill-sources/list`
        : "/api/admin/projects/skill-sources/list";
      const result = await api.post<{ skills: string[]; output: string }>(path, {
        source: row.source.trim(),
        ...(row.sshUser.trim() ? { sshUser: row.sshUser.trim() } : {}),
        ...(sshPort !== undefined ? { sshPort } : {}),
        ...(row.sshKeyPath.trim() ? { sshKeyPath: row.sshKeyPath.trim() } : {}),
        ...(row.sshKnownHostsPath.trim() ? { sshKnownHostsPath: row.sshKnownHostsPath.trim() } : {}),
      });
      updateRow(id, {
        listing: false,
        availableSkills: result.skills,
        listError: result.skills.length > 0 ? null : "No skills parsed from source output",
      });
    } catch (e) {
      updateRow(id, { listing: false, listError: e instanceof Error ? e.message : "Failed to list skills" });
    }
  };

  const toggleListedSkill = (id: string, skill: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return;
    const skills = selectedSkillSet(row);
    if (skills.has(skill)) skills.delete(skill);
    else skills.add(skill);
    updateRow(id, { skillsText: skillsTextFromSet(skills) });
  };

  return (
    <Field
      label="Local Project Skill"
      hint="Enable loading local repository skills from the configured workspace path. Remote sources below are installed when configured. Only use trusted skills."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", userSelect: "none", paddingBottom: 8 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
              style={{ accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
            />
            <span>Enable</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
            path
            <FieldInput
              value={localSkillsPath}
              placeholder=".github/skills"
              onChange={(e) => onLocalSkillsPathChange(e.target.value)}
            />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-dim)" }}>External skill sources</div>
          <button type="button" className="btn ghost" style={{ fontSize: "12px", padding: "5px 10px" }} onClick={() => setRows((prev) => [...prev, emptySkillSourceRow()])}>
            <Icon name="plus" size={12} /> Add source
          </button>
        </div>
        {rows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((row) => {
              const showSshFields = isSshSkillSource(row.source);
              return (
                <div key={row.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr) auto auto auto", gap: 8, alignItems: "end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                      Source
                      <FieldInput
                        value={row.source}
                        placeholder="ssh://host.example.com/org/skills"
                        onChange={(e) => updateRow(row.id, { source: e.target.value })}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                      Skills to load
                      <FieldInput
                        value={row.skillsText}
                        placeholder="skill-a, skill-b"
                        disabled={row.installAll}
                        onChange={(e) => updateRow(row.id, { skillsText: e.target.value })}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "12px", color: "var(--text-dim)", whiteSpace: "nowrap", paddingBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={row.installAll}
                        onChange={(e) => updateRow(row.id, { installAll: e.target.checked })}
                        style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                      />
                      Install all
                    </label>
                    <button type="button" className="btn ghost" style={{ fontSize: "12px", padding: "5px 10px", marginBottom: 2 }} disabled={row.listing} onClick={() => void listRowSkills(row.id)}>
                      {row.listing ? "Listing…" : "List skills"}
                    </button>
                    <button type="button" className="iconbtn" onClick={() => setRows((prev) => prev.filter((candidate) => candidate.id !== row.id))}>
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  {showSshFields && (
                    <div style={{ display: "grid", gridTemplateColumns: "130px 90px minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                        SSH user
                        <FieldInput value={row.sshUser} placeholder="ssh-user" onChange={(e) => updateRow(row.id, { sshUser: e.target.value })} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                        SSH port
                        <FieldInput value={row.sshPort} placeholder="port" onChange={(e) => updateRow(row.id, { sshPort: e.target.value })} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                        SSH private key path
                        <FieldInput value={row.sshKeyPath} placeholder="/home/ve/.ssh/id_ed25519" onChange={(e) => updateRow(row.id, { sshKeyPath: e.target.value })} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "11px", color: "var(--text-faint)" }}>
                        SSH known_hosts path
                        <FieldInput value={row.sshKnownHostsPath} placeholder="/home/ve/.ssh/known_hosts" onChange={(e) => updateRow(row.id, { sshKnownHostsPath: e.target.value })} />
                      </label>
                    </div>
                  )}
                  {row.availableSkills.length > 0 && !row.installAll && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: "11px", color: "var(--text-faint)", fontWeight: 600 }}>Available skills</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {row.availableSkills.map((skill) => {
                          const selected = selectedSkillSet(row).has(skill);
                          return (
                            <button
                              key={skill}
                              type="button"
                              className={selected ? "btn primary" : "btn ghost"}
                              style={{ fontSize: "12px", padding: "4px 8px" }}
                              onClick={() => toggleListedSkill(row.id, skill)}
                            >
                              {skill}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {row.listError && <div style={{ fontSize: "11.5px", color: "var(--danger)" }}>{row.listError}</div>}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: "11.5px", color: "var(--text-faint)", lineHeight: 1.45 }}>
          Local skills are loaded from the configured workspace-relative path. External sources are installed globally in the agent home volume with <code>npx skills</code>. SSH sources can use the orchestrator SSH agent or a configured private key path; set a <code>known_hosts</code> path to enforce host key verification.
        </div>
      </div>
    </Field>
  );
}
