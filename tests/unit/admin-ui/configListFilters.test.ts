import { describe, expect, it } from "vitest";
import {
  EMPTY_LIST_FILTER,
  applyListFilter,
  isListFiltered,
  listSortOptions,
  matchesSearch,
  type ListConfig,
} from "../../../src/admin/ui/views/ConfigView/listFilters.js";
import {
  agentListConfig,
  groupListConfig,
  integrationListConfig,
  policyListConfig,
  projectListConfig,
  promptListConfig,
  userListConfig,
} from "../../../src/admin/ui/views/ConfigView/configListConfigs.js";
import type {
  ApiAgent,
  ApiGroup,
  ApiIntegration,
  ApiPlugin,
  ApiPolicy,
  ApiProject,
  ApiPrompt,
  ApiUser,
} from "../../../src/admin/ui/types.js";

interface Row { id: string; name: string; kind: string; tags: string[]; updatedAt?: string | undefined; createdAt?: string | undefined }

const rowConfig: ListConfig<Row> = {
  search: (row) => [row.name, row.id],
  name: (row) => row.name,
  updatedAt: (row) => row.updatedAt,
  createdAt: (row) => row.createdAt,
  filters: [
    { id: "kind", label: "Kind", allLabel: "All kinds", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], value: (row) => row.kind },
    { id: "tag", label: "Tag", allLabel: "All tags", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], value: (row) => row.tags },
  ],
};

const rows: Row[] = [
  { id: "r1", name: "beta runner", kind: "a", tags: ["x"], updatedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "r2", name: "Alpha", kind: "b", tags: ["x", "y"], updatedAt: "2026-01-05T00:00:00.000Z" },
  { id: "r3", name: "gamma", kind: "a", tags: [], createdAt: "2026-01-03T00:00:00.000Z" },
];

describe("matchesSearch", () => {
  it("matches every whitespace-separated term case-insensitively across fields", () => {
    expect(matchesSearch("BETA run", ["beta runner", "r1"])).toBe(true);
    expect(matchesSearch("beta r1", ["beta runner", "r1"])).toBe(true);
    expect(matchesSearch("beta zeta", ["beta runner", "r1"])).toBe(false);
  });

  it("treats a blank query as a match and ignores missing fields", () => {
    expect(matchesSearch("   ", [null, undefined])).toBe(true);
    expect(matchesSearch("x", [null, undefined])).toBe(false);
  });
});

describe("applyListFilter", () => {
  it("returns items in server order by default", () => {
    expect(applyListFilter(rows, EMPTY_LIST_FILTER, rowConfig).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("combines search with single- and multi-valued filters", () => {
    expect(applyListFilter(rows, { ...EMPTY_LIST_FILTER, filters: { kind: "a" } }, rowConfig).map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(applyListFilter(rows, { ...EMPTY_LIST_FILTER, filters: { tag: "y" } }, rowConfig).map((r) => r.id)).toEqual(["r2"]);
    expect(applyListFilter(rows, { ...EMPTY_LIST_FILTER, query: "a", filters: { tag: "x" } }, rowConfig).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("ignores stale filter values that are no longer offered", () => {
    expect(applyListFilter(rows, { ...EMPTY_LIST_FILTER, filters: { kind: "removed" } }, rowConfig)).toHaveLength(3);
  });

  it("sorts by name and by dates with missing dates last", () => {
    const sortBy = (sort: string) => applyListFilter(rows, { ...EMPTY_LIST_FILTER, sort }, rowConfig).map((r) => r.id);
    expect(sortBy("name-asc")).toEqual(["r2", "r1", "r3"]);
    expect(sortBy("name-desc")).toEqual(["r3", "r1", "r2"]);
    expect(sortBy("updated")).toEqual(["r2", "r1", "r3"]);
    expect(sortBy("created")).toEqual(["r3", "r1", "r2"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    applyListFilter(input, { ...EMPTY_LIST_FILTER, sort: "name-asc" }, rowConfig);
    expect(input.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("list helpers", () => {
  it("offers date sorts only when the list exposes them", () => {
    expect(listSortOptions(rowConfig).map((o) => o.value)).toEqual(["default", "name-asc", "name-desc", "updated", "created"]);
    expect(listSortOptions({ ...rowConfig, createdAt: undefined }).map((o) => o.value)).toEqual(["default", "name-asc", "name-desc", "updated"]);
  });

  it("reports whether any search, filter, or sort is active", () => {
    expect(isListFiltered(EMPTY_LIST_FILTER)).toBe(false);
    expect(isListFiltered({ ...EMPTY_LIST_FILTER, filters: { kind: "all" } })).toBe(false);
    expect(isListFiltered({ ...EMPTY_LIST_FILTER, query: " x " })).toBe(true);
    expect(isListFiltered({ ...EMPTY_LIST_FILTER, filters: { kind: "a" } })).toBe(true);
    expect(isListFiltered({ ...EMPTY_LIST_FILTER, sort: "name-asc" })).toBe(true);
  });
});

const ts = "2026-01-01T00:00:00.000Z";

const integrations: ApiIntegration[] = [
  { id: "int-gh", provider: "github", name: "Main GitHub", enabled: true, capabilities: [], domainCapabilities: ["issue_tracking", "code_review"] },
  { id: "int-cp", provider: "copilot", name: "Copilot engine", enabled: false, capabilities: [], domainCapabilities: ["agent_execution"] },
];

const plugins: ApiPlugin[] = [
  { provider: "github", name: "GitHub", capabilities: [], domainCapabilities: [], requiredFields: [], agentConfigFields: [] },
  { provider: "copilot", name: "GitHub Copilot", capabilities: [], domainCapabilities: [], requiredFields: [], agentConfigFields: [] },
];

function agent(overrides: Partial<ApiAgent>): ApiAgent {
  return {
    id: "agent", name: "Agent", type: "coding", integrationId: null, enabled: true, maxConcurrent: null,
    model: null, reviewStrategy: "ve_direct", systemPromptId: null, instructionsPromptId: null,
    feedbackInstructionsPromptId: null, createdAt: ts, updatedAt: ts, ...overrides,
  };
}

const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);

describe("section list configs", () => {
  it("filters integrations by provider display name, capability, and status", () => {
    const config = integrationListConfig(integrations, plugins);
    expect(config.filters.find((f) => f.id === "provider")?.options).toEqual([
      { value: "github", label: "GitHub" },
      { value: "copilot", label: "GitHub Copilot" },
    ]);
    expect(ids(applyListFilter(integrations, { ...EMPTY_LIST_FILTER, query: "copilot" }, config))).toEqual(["int-cp"]);
    expect(ids(applyListFilter(integrations, { ...EMPTY_LIST_FILTER, filters: { capability: "code_review" } }, config))).toEqual(["int-gh"]);
    expect(ids(applyListFilter(integrations, { ...EMPTY_LIST_FILTER, filters: { status: "disabled" } }, config))).toEqual(["int-cp"]);
  });

  it("resolves agent engines through their integration and exposes unassigned agents", () => {
    const agents = [
      agent({ id: "a1", name: "Coder", integrationId: "int-cp", model: "gpt-5" }),
      agent({ id: "a2", name: "Reviewer", type: "review", integrationId: null }),
    ];
    const config = agentListConfig(agents, integrations, plugins);
    expect(config.filters.find((f) => f.id === "engine")?.options).toEqual([
      { value: "copilot", label: "GitHub Copilot" },
      { value: "none", label: "Unassigned" },
    ]);
    expect(ids(applyListFilter(agents, { ...EMPTY_LIST_FILTER, filters: { engine: "none" } }, config))).toEqual(["a2"]);
    expect(ids(applyListFilter(agents, { ...EMPTY_LIST_FILTER, query: "gpt" }, config))).toEqual(["a1"]);
    expect(ids(applyListFilter(agents, { ...EMPTY_LIST_FILTER, query: "copilot" }, config))).toEqual(["a1"]);
    expect(ids(applyListFilter(agents, { ...EMPTY_LIST_FILTER, filters: { type: "review" } }, config))).toEqual(["a2"]);
  });

  it("searches projects by agent name and filters by agent", () => {
    const agents = [agent({ id: "a1", name: "Night shift" })];
    const projects: ApiProject[] = [
      { id: "p1", name: "Backend", type: "coding", enabled: true, agentId: "a1", createdAt: ts, updatedAt: ts },
      { id: "p2", name: "Reviews", type: "review", enabled: false, agentId: null, createdAt: ts, updatedAt: ts },
    ];
    const config = projectListConfig(projects, agents);
    expect(ids(applyListFilter(projects, { ...EMPTY_LIST_FILTER, query: "night" }, config))).toEqual(["p1"]);
    expect(ids(applyListFilter(projects, { ...EMPTY_LIST_FILTER, filters: { agent: "none" } }, config))).toEqual(["p2"]);
    expect(ids(applyListFilter(projects, { ...EMPTY_LIST_FILTER, filters: { status: "enabled" } }, config))).toEqual(["p1"]);
  });

  it("searches prompt content and filters by origin and usage", () => {
    const prompts: ApiPrompt[] = [
      { id: "system_generic_code", label: "Default", content: "You are careful", promptType: "system", builtin: true, updatedAt: ts, usedByCount: 2 },
      { id: "custom", label: "Mine", content: "Write tests", promptType: "instructions", updatedAt: ts },
    ];
    const config = promptListConfig(prompts);
    expect(ids(applyListFilter(prompts, { ...EMPTY_LIST_FILTER, query: "tests" }, config))).toEqual(["custom"]);
    expect(ids(applyListFilter(prompts, { ...EMPTY_LIST_FILTER, filters: { origin: "builtin" } }, config))).toEqual(["system_generic_code"]);
    expect(ids(applyListFilter(prompts, { ...EMPTY_LIST_FILTER, filters: { usage: "unused" } }, config))).toEqual(["custom"]);
    expect(listSortOptions(config).map((o) => o.value)).not.toContain("created");
  });

  it("filters users by role and status", () => {
    const users: ApiUser[] = [
      { id: "u1", username: "alice", role: "admin", enabled: true, createdAt: ts, updatedAt: ts },
      { id: "u2", username: "bob", role: "viewer", enabled: false, createdAt: ts, updatedAt: ts },
    ];
    const config = userListConfig();
    expect(ids(applyListFilter(users, { ...EMPTY_LIST_FILTER, filters: { role: "viewer" } }, config))).toEqual(["u2"]);
    expect(ids(applyListFilter(users, { ...EMPTY_LIST_FILTER, filters: { status: "enabled" } }, config))).toEqual(["u1"]);
    expect(ids(applyListFilter(users, { ...EMPTY_LIST_FILTER, query: "BOB" }, config))).toEqual(["u2"]);
  });

  it("filters groups by membership and policies by origin and assignment", () => {
    const groups: ApiGroup[] = [
      { id: "g1", name: "Ops", description: "On-call rotation", createdAt: ts, updatedAt: ts, memberCount: 3 },
      { id: "g2", name: "Empty", description: "", createdAt: ts, updatedAt: ts },
    ];
    expect(ids(applyListFilter(groups, { ...EMPTY_LIST_FILTER, filters: { members: "empty" } }, groupListConfig()))).toEqual(["g2"]);
    expect(ids(applyListFilter(groups, { ...EMPTY_LIST_FILTER, query: "rotation" }, groupListConfig()))).toEqual(["g1"]);

    const policies: ApiPolicy[] = [
      { id: "admin", name: "Admin", description: "", builtin: true, createdAt: ts, updatedAt: ts, bindingCount: 1 },
      { id: "p2", name: "Reader", description: "Read only", builtin: false, createdAt: ts, updatedAt: ts, bindingCount: 0 },
    ];
    expect(ids(applyListFilter(policies, { ...EMPTY_LIST_FILTER, filters: { origin: "custom" } }, policyListConfig()))).toEqual(["p2"]);
    expect(ids(applyListFilter(policies, { ...EMPTY_LIST_FILTER, filters: { assignment: "assigned" } }, policyListConfig()))).toEqual(["admin"]);
  });
});
