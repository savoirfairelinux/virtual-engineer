import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../../../src/admin/authorization/permissions.js";
import {
  POLICY_GROUPS,
  applyLinkedResources,
  draftIssues,
  draftToRules,
  emptyDraft,
  formatNameWithId,
  linkedResourcesForProject,
  rulesToDraft,
} from "../../../src/admin/ui/views/ConfigView/policyRuleModel.js";
import type { ApiAgent, ApiPrompt } from "../../../src/admin/ui/types.js";

const agent: ApiAgent = {
  id: "agent-1",
  name: "Coder",
  type: "coding",
  integrationId: "copilot-1",
  enabled: true,
  maxConcurrent: 1,
  model: null,
  reviewStrategy: "ve_direct",
  systemPromptId: "system_generic_code",
  instructionsPromptId: "prompt-custom",
  feedbackInstructionsPromptId: null,
  createdAt: "",
  updatedAt: "",
};

const prompts: ApiPrompt[] = [
  { id: "system_generic_code", label: "System", content: "", promptType: "system", builtin: true, updatedAt: "" },
  { id: "prompt-custom", label: "Custom", content: "", promptType: "instructions", builtin: false, updatedAt: "" },
];

describe("policyRuleModel", () => {
  it("covers every server permission exactly once", () => {
    const catalog = POLICY_GROUPS.flatMap((group) => group.actions.map((action) => action.permission));
    expect(new Set(catalog).size).toBe(catalog.length);
    expect([...catalog].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("round-trips uniform scoped rules and global permissions", () => {
    const rules = [
      { permission: "integration.read", resourceId: "int-1" },
      { permission: "integration.read", resourceId: "int-2" },
      { permission: "integration.write", resourceId: "int-1" },
      { permission: "integration.write", resourceId: "int-2" },
      { permission: "overview.read", resourceId: null },
      { permission: "prompt.create", resourceId: null },
    ];
    const draft = rulesToDraft(rules);
    expect(draft.nonUniform).toBe(false);
    expect(draft.groups.integration).toEqual({ actions: ["integration.read", "integration.write"], resourceIds: ["int-1", "int-2"] });
    expect(draft.globalPermissions).toEqual(["overview.read", "prompt.create"]);
    expect(draftToRules(draft)).toEqual(rules);
  });

  it("flags non-uniform rules and normalizes them to actions × resources", () => {
    const draft = rulesToDraft([
      { permission: "agent.read", resourceId: "a" },
      { permission: "agent.write", resourceId: "b" },
    ]);
    expect(draft.nonUniform).toBe(true);
    expect(draftToRules(draft)).toHaveLength(4);
  });

  it("keeps legacy all-resource grants and unknown rules", () => {
    const draft = rulesToDraft([
      { permission: "task.read", resourceId: null },
      { permission: "legacy.thing", resourceId: "x" },
    ]);
    expect(draft.legacyGlobalRules).toEqual([{ permission: "task.read", resourceId: null }]);
    expect(draft.unknownRules).toEqual([{ permission: "legacy.thing", resourceId: "x" }]);
    expect(draftToRules(draft)).toEqual([
      { permission: "task.read", resourceId: null },
      { permission: "legacy.thing", resourceId: "x" },
    ]);
  });

  it("reports groups missing resources or actions", () => {
    const draft = emptyDraft();
    draft.groups.project = { actions: ["project.read"], resourceIds: [] };
    draft.groups.prompt = { actions: [], resourceIds: ["p"] };
    expect(draftIssues(draft)).toEqual({ missingResources: ["project"], missingActions: ["prompt"] });
  });

  it("formats names with ids", () => {
    expect(formatNameWithId("Readers", "grp-1")).toBe("Readers (grp-1)");
    expect(formatNameWithId(null, "grp-1")).toBe("grp-1");
  });

  it("collects linked resources of a project, skipping built-in prompts", () => {
    const linked = linkedResourcesForProject({
      agentId: "agent-1",
      agentOverrideJson: JSON.stringify({ feedbackInstructionsPromptId: "prompt-feedback" }),
      ticketSource: { integration: { id: "redmine-1" } },
      reviewConfig: null,
      pushTargets: [{ integrationId: "gerrit-1" }, { integrationId: "gerrit-1" }, { integrationId: null }],
    }, [agent], prompts);
    expect(linked).toEqual({
      agent: ["agent-1"],
      integration: ["copilot-1", "redmine-1", "gerrit-1"],
      prompt: ["prompt-custom", "prompt-feedback"],
    });
  });

  it("applies linked resources with read access and reports additions", () => {
    const draft = emptyDraft();
    draft.groups.integration = { actions: ["integration.write"], resourceIds: ["redmine-1"] };
    const { draft: next, added } = applyLinkedResources(draft, { agent: ["agent-1"], integration: ["redmine-1", "gerrit-1"], prompt: [] });
    expect(next.groups.integration).toEqual({ actions: ["integration.write", "integration.read"], resourceIds: ["redmine-1", "gerrit-1"] });
    expect(next.groups.agent).toEqual({ actions: ["agent.read"], resourceIds: ["agent-1"] });
    expect(next.groups.prompt).toEqual({ actions: [], resourceIds: [] });
    expect(added).toEqual({ agent: ["agent-1"], integration: ["gerrit-1"], prompt: [] });
    expect(draft.groups.integration.resourceIds).toEqual(["redmine-1"]);
  });
});
