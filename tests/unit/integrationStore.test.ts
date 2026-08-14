import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-test");
}

describe("SqliteStateStore — IntegrationStore", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  describe("upsertIntegration", () => {
    it("creates a new integration", async () => {
      const integration = await store.upsertIntegration({
        id: "int-1",
        provider: "redmine",
        name: "Redmine Production",
        configJson: JSON.stringify({ baseUrl: "http://redmine:3000", apiKey: "key123" }),
        enabled: false,
      });

      expect(integration.id).toBe("int-1");
      expect(integration.provider).toBe("redmine");
      expect(integration.name).toBe("Redmine Production");
      expect(integration.enabled).toBe(false);
      expect(integration.createdAt).toBeInstanceOf(Date);
      expect(integration.updatedAt).toBeInstanceOf(Date);
    });

    it("updates an existing integration", async () => {
      await store.upsertIntegration({
        id: "int-1",
        provider: "redmine",
        name: "Redmine v1",
        configJson: "{}",
        enabled: false,
      });

      const updated = await store.upsertIntegration({
        id: "int-1",
        provider: "redmine",
        name: "Redmine v2",
        configJson: JSON.stringify({ baseUrl: "http://new-redmine:3000" }),
        enabled: true,
      });

      expect(updated.name).toBe("Redmine v2");
      expect(updated.enabled).toBe(true);
    });
  });

  describe("getIntegrations", () => {
    it("returns all integrations", async () => {
      await store.upsertIntegration({ id: "a", provider: "redmine", name: "R", configJson: "{}", enabled: true });
      await store.upsertIntegration({ id: "b", provider: "gerrit", name: "G", configJson: "{}", enabled: false });

      const all = await store.getIntegrations();
      expect(all).toHaveLength(2);
      expect(all.map((i) => i.id).sort()).toEqual(["a", "b"]);
    });

    it("returns empty array when no integrations exist", async () => {
      const all = await store.getIntegrations();
      expect(all).toEqual([]);
    });
  });

  describe("getIntegration", () => {
    it("returns an integration by id", async () => {
      await store.upsertIntegration({ id: "x", provider: "copilot", name: "Copilot", configJson: "{}", enabled: true });

      const result = await store.getIntegration("x");
      expect(result?.id).toBe("x");
      expect(result?.provider).toBe("copilot");
    });

    it("returns null for unknown id", async () => {
      const result = await store.getIntegration("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getIntegrationReferenceDetails", () => {
    it("returns dependent agents and project integration uses with names", async () => {
      await store.upsertIntegration({ id: "int-1", provider: "redmine", name: "Shared Redmine", configJson: "{}", enabled: true });
      const agent = await store.createAgent({
        name: "Build Agent",
        type: "coding",
        modelConfigJson: "{}",
        integrationId: "int-1",
        systemPromptId: "system_generic_code",
        instructionsPromptId: "instructions_generic_code",
      });
      const project = await store.createProject({ name: "Platform", type: "coding", agentId: agent.id });
      await store.setProjectTicketSource(project.id, { integrationId: "int-1", ticketProjectKey: "PLATFORM" });
      await store.addProjectPushTarget(project.id, {
        integrationId: "int-1",
        repoKey: "platform/app",
        cloneUrl: "https://example.test/platform/app.git",
        targetBranch: "main",
        role: "primary",
        commitOrder: 0,
        localPath: ".",
      });

      const references = await store.getIntegrationReferenceDetails("int-1");

      expect(references).toEqual({
        agents: [{ id: agent.id, name: "Build Agent" }],
        projectBindings: [{ projectId: project.id, projectName: "Platform", capability: "issue_tracking" }],
        projectPushTargets: [{ projectId: project.id, projectName: "Platform", repoKey: "platform/app" }],
      });
      await expect(store.countIntegrationReferences("int-1")).resolves.toBe(3);
    });
  });

  describe("deleteIntegration", () => {
    it("removes an integration", async () => {
      await store.upsertIntegration({ id: "d1", provider: "redmine", name: "Redmine", configJson: "{}", enabled: true });
      await store.deleteIntegration("d1");

      const result = await store.getIntegration("d1");
      expect(result).toBeNull();
    });

    it("disables dependents and removes project bindings before deleting", async () => {
      await store.upsertIntegration({ id: "d2", provider: "redmine", name: "Redmine", configJson: "{}", enabled: true });
      const agent = await store.createAgent({
        name: "Dependent Agent",
        type: "coding",
        modelConfigJson: "{}",
        integrationId: "d2",
        systemPromptId: "system_generic_code",
        instructionsPromptId: "instructions_generic_code",
        enabled: true,
      });
      const project = await store.createProject({
        name: "Dependent Project",
        type: "coding",
        agentId: agent.id,
        enabled: true,
      });
      await store.setProjectTicketSource(project.id, {
        integrationId: "d2",
        ticketProjectKey: "DEPENDENT",
      });
      await store.addProjectPushTarget(project.id, {
        integrationId: "d2",
        repoKey: "dependent/repo",
        cloneUrl: "https://example.test/dependent/repo.git",
        targetBranch: "main",
        role: "primary",
        commitOrder: 0,
        localPath: ".",
      });

      await store.deleteIntegration("d2");

      await expect(store.getIntegration("d2")).resolves.toBeNull();
      await expect(store.getAgentById(agent.id)).resolves.toMatchObject({
        integrationId: null,
        enabled: false,
      });
      await expect(store.getProjectById(project.id)).resolves.toMatchObject({ enabled: false });
      await expect(store.getProjectTicketSource(project.id)).resolves.toBeNull();
      await expect(store.listProjectPushTargets(project.id)).resolves.toEqual([]);
    });

    it("does not throw when deleting nonexistent integration", async () => {
      await expect(store.deleteIntegration("nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("setIntegrationEnabled", () => {
    it("enables a disabled integration", async () => {
      await store.upsertIntegration({ id: "e1", provider: "gerrit", name: "Gerrit", configJson: "{}", enabled: false });

      const result = await store.setIntegrationEnabled("e1", true);
      expect(result.enabled).toBe(true);
    });

    it("disables an enabled integration", async () => {
      await store.upsertIntegration({ id: "e2", provider: "gerrit", name: "Gerrit", configJson: "{}", enabled: true });

      const result = await store.setIntegrationEnabled("e2", false);
      expect(result.enabled).toBe(false);
    });

    it("throws for unknown integration", async () => {
      await expect(store.setIntegrationEnabled("unknown", true)).rejects.toThrow(
        "Integration not found: unknown"
      );
    });
  });

  describe("config persistence", () => {
    it("stores and retrieves JSON config correctly", async () => {
      const config = { baseUrl: "http://redmine:3000", apiKey: "secret", userId: 42 };
      await store.upsertIntegration({
        id: "cfg-1",
        provider: "redmine",
        name: "Redmine",
        configJson: JSON.stringify(config),
        enabled: true,
      });

      const result = await store.getIntegration("cfg-1");
      expect(JSON.parse(result!.configJson)).toEqual(config);
    });
  });
});
