import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Modal, Field, FieldInput, FieldSelect, FieldTextarea } from "../../components/Modal.tsx";
import type { ApiProject, ApiAgent } from "../../types.ts";

interface RuntimePolicy {
  id: string;
  name: string;
  kind: "filesystem" | "network" | "process" | "inference";
  yaml: string;
  description: string;
}

const KINDS: RuntimePolicy["kind"][] = ["network", "filesystem", "process", "inference"];

const TEMPLATE = `network:
  default: deny
  allow:
    - host: inference.local
filesystem:
  allow_write: [/workspace]
process:
  no_new_privileges: true
`;

export function PoliciesSection() {
  const [policies, setPolicies] = useState<RuntimePolicy[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuntimePolicy | null>(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<RuntimePolicy | null>(null);

  async function load() {
    setError(null);
    try {
      const [polData, prjData, agData] = await Promise.all([
        api.get<{ policies: RuntimePolicy[] }>("/api/admin/runtime/policies"),
        api.get<{ projects: ApiProject[] }>("/api/admin/projects"),
        api.get<{ agents: ApiAgent[] }>("/api/admin/agents"),
      ]);
      setPolicies(polData.policies);
      setProjects(prjData.projects);
      setAgents(agData.agents);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load policies");
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this policy? Its bindings are removed too.")) return;
    try {
      await api.delete(`/api/admin/runtime/policies/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "22px" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Policies</div>
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Runtime policies</h1>
          <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px", maxWidth: "560px" }}>
            Declarative deny-by-default sandbox policies applied by the OpenShell runtime.
            Create a policy then <strong>assign</strong> it to a project or agent.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New policy</button>
      </div>

      {error && <div className="card" style={{ padding: "12px 14px", marginBottom: "16px", color: "var(--danger, #f85149)" }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {policies.length === 0 ? (
          <div style={{ padding: "22px", color: "var(--text-ghost)", fontSize: "13px" }}>No policies yet.</div>
        ) : (
          policies.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: "flex", alignItems: "center", gap: "12px", padding: "13px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--border-soft)",
              }}
            >
              <span className="tag" style={{ textTransform: "uppercase", fontSize: "10px" }}>{p.kind}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: "13.5px" }}>{p.name}</div>
                {p.description && <div style={{ fontSize: "11px", color: "var(--text-ghost)" }}>{p.description}</div>}
              </div>
              <button className="btn" onClick={() => setAssigning(p)} title="Assign to a project or agent">Assign</button>
              <button className="btn" onClick={() => setEditing(p)}>Edit</button>
              <button className="btn" onClick={() => void handleDelete(p.id)}>Delete</button>
            </div>
          ))
        )}
      </div>

      {(creating || editing) && (
        <PolicyEditor
          policy={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void load(); }}
        />
      )}

      {assigning && (
        <AssignModal
          policy={assigning}
          projects={projects}
          agents={agents}
          onClose={() => setAssigning(null)}
          onSaved={() => { setAssigning(null); void load(); }}
        />
      )}
    </>
  );
}

function AssignModal({
  policy, projects, agents, onClose, onSaved,
}: {
  policy: RuntimePolicy;
  projects: ApiProject[];
  agents: ApiAgent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState<"project" | "agent">("project");
  const [targetId, setTargetId] = useState(projects[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const items = target === "project" ? projects : agents;

  async function handleAssign() {
    if (!targetId) { setError("Select a target"); return; }
    setError(null);
    setSaving(true);
    try {
      await api.post(`/api/admin/runtime/policies/${policy.id}/bindings`, {
        ...(target === "project" ? { projectId: targetId } : { agentId: targetId }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Assign "${policy.name}"`}
      sub="Apply this policy to a project or agent"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !targetId} onClick={() => void handleAssign()}>
            {saving ? "Assigning…" : "Assign"}
          </button>
        </>
      }
    >
      {error && <div style={{ marginBottom: "12px", color: "var(--danger, #f85149)", fontSize: "13px" }}>{error}</div>}
      <Field label="Target type">
        <FieldSelect value={target} onChange={(e) => {
          const v = e.target.value as "project" | "agent";
          setTarget(v);
          setTargetId((v === "project" ? projects[0]?.id : agents[0]?.id) ?? "");
        }}>
          <option value="project">Project</option>
          <option value="agent">Agent</option>
        </FieldSelect>
      </Field>
      <Field label={target === "project" ? "Project" : "Agent"}>
        <FieldSelect value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          {items.length === 0
            ? <option value="">— no {target}s found —</option>
            : items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)
          }
        </FieldSelect>
      </Field>
      <p style={{ fontSize: "12px", color: "var(--text-ghost)", margin: "4px 0 0" }}>
        The policy will be applied before each agent cycle for the selected {target}.
        Multiple policies can be assigned; all are applied.
      </p>
    </Modal>
  );
}

function PolicyEditor({ policy, onClose, onSaved }: { policy: RuntimePolicy | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(policy?.name ?? "");
  const [kind, setKind] = useState<RuntimePolicy["kind"]>(policy?.kind ?? "network");
  const [description, setDescription] = useState(policy?.description ?? "");
  const [yaml, setYaml] = useState(policy?.yaml ?? TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      if (policy) {
        await api.put(`/api/admin/runtime/policies/${policy.id}`, { name, kind, description, yaml });
      } else {
        await api.post("/api/admin/runtime/policies", { name, kind, description, yaml });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={policy ? "Edit policy" : "New policy"}
      sub="Deny-by-default sandbox policy"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {error && <div style={{ marginBottom: "12px", color: "var(--danger, #f85149)", fontSize: "13px" }}>{error}</div>}
      <Field label="Name" required>
        <FieldInput value={name} onChange={(e) => setName(e.target.value)} placeholder="review-readonly" />
      </Field>
      <Field label="Kind" required>
        <FieldSelect value={kind} onChange={(e) => setKind(e.target.value as RuntimePolicy["kind"])}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </FieldSelect>
      </Field>
      <Field label="Description">
        <FieldInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="read-only egress" />
      </Field>
      <Field label="Policy YAML" hint="Applied to the sandbox before the agent runs.">
        <FieldTextarea rows={12} value={yaml} onChange={(e) => setYaml(e.target.value)} style={{ fontFamily: "var(--mono, monospace)", fontSize: "12.5px" }} />
      </Field>
    </Modal>
  );
}



