/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFormModal } from "../../../src/admin/ui/views/ConfigView/ProjectFormModal.js";
import { buildSkillSourcesPayload, emptySkillSourceRow } from "../../../src/admin/ui/views/ConfigView/ProjectSkillSourcesField.js";
import type { ApiAgent, ApiIntegration } from "../../../src/admin/ui/types.js";

const codingAgent: ApiAgent = {
  id: "agent-1",
  name: "Coding agent",
  type: "coding",
  integrationId: null,
  enabled: true,
  maxConcurrent: 1,
  model: "auto",
  reviewStrategy: "ve_direct",
  systemPromptId: null,
  instructionsPromptId: null,
  feedbackInstructionsPromptId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function gerritIntegration(id: string, name: string): ApiIntegration {
  return {
    id,
    provider: "gerrit",
    name,
    enabled: true,
    capabilities: [],
    domainCapabilities: ["source_control"],
    discoveredResources: {
      repositories: [{
        key: "platform/runtime",
        name: "Runtime",
        cloneUrlSsh: "ssh://git@gerrit.example.com:29418/platform/runtime.git",
        defaultBranch: "main",
        branches: ["main"],
      }],
    },
  };
}

describe("ProjectFormModal repository integration resolution", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("submits SSH skill sources with or without an optional known_hosts path", () => {
    const row = { ...emptySkillSourceRow(), source: "skills.example.com:team/repo", installAll: true };
    expect(buildSkillSourcesPayload([row])).toEqual([{ source: row.source, skills: [], installAll: true }]);
    expect(buildSkillSourcesPayload([{ ...row, sshKnownHostsPath: "/keys/known_hosts" }])).toEqual([{
      source: row.source, skills: [], installAll: true, sshKnownHostsPath: "/keys/known_hosts",
    }]);
  });

  it("renders the add-project form when crypto.randomUUID is unavailable", () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      subtle: originalCrypto.subtle,
    } as Crypto);

    try {
      render(
        <ProjectFormModal
          agents={[{ ...codingAgent, integrationId: "copilot-1" }]}
          integrations={[{
            id: "copilot-1", name: "Copilot", provider: "copilot", enabled: true,
            capabilities: [], domainCapabilities: ["agent_execution"],
          }]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByRole("combobox", { name: /^Agent/ }), { target: { value: codingAgent.id } });

      expect(screen.getByText("Additional Skills")).toBeTruthy();
      expect(screen.queryByDisplayValue("ssh://g1.sfl.io/sfl/agent-skills")).toBeNull();
    } finally {
      vi.stubGlobal("crypto", originalCrypto);
    }
  });

  it("preserves push target execution metadata on an unchanged save", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      domainCapabilities: ["source_control", "issue_tracking"],
    };
    const storedTarget = {
      integrationId: integration.id,
      repoKey: "platform/runtime",
      cloneUrl: "ssh://gerrit.example.com/platform/runtime.git",
      targetBranch: "stable",
      role: "submodule" as const,
      commitOrder: 7,
      localPath: "layers/runtime",
      sshKeyPath: "/app/secrets/gerrit-deploy",
      reviewerEmails: ["reviewer@example.com"],
    };
    let savedTargets: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/projects/project-1/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200 });
      }
      if (path === "/api/admin/projects/project-1" && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body)) as { pushTargets: Array<Record<string, unknown>> };
        savedTargets = payload.pushTargets;
        return new Response(JSON.stringify({ project: { id: "project-1" } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [storedTarget],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(savedTargets).toHaveLength(1));
    expect(savedTargets[0]).toMatchObject({
      role: "submodule",
      commitOrder: 7,
      sshKeyPath: "/app/secrets/gerrit-deploy",
      reviewerEmails: ["reviewer@example.com"],
    });
  });

  it("confirms active tasks before resubmitting a project execution change", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      domainCapabilities: ["source_control", "issue_tracking"],
    };
    const putBodies: Array<Record<string, unknown>> = [];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/projects/project-1/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200 });
      }
      if (path === "/api/admin/projects/project-1" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        putBodies.push(body);
        if (putBodies.length <= 2) {
          const taskId = putBodies.length === 1 ? "task-1" : "task-2";
          return new Response(JSON.stringify({
            error: "Conflict",
            message: "Execution configuration changed",
            code: "ACTIVE_TASKS_CONFIRMATION_REQUIRED",
            activeTasks: [{
              taskId,
              ticketId: `TCK-${taskId === "task-1" ? "9" : "10"}`,
              ticketTitle: taskId === "task-1" ? "Build firmware" : "Build bootloader",
              taskType: "code-gen",
              state: "IN_REVIEW",
            }],
          }), { status: 409 });
        }
        return new Response(JSON.stringify({ project: { id: "project-1" } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const onSaved = vi.fn();
    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: "redmine-1", name: "Tickets", provider: "redmine" },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/runtime",
            cloneUrl: "https://gerrit.example.com/platform/runtime.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(1, expect.stringContaining("Build firmware (task-1, IN_REVIEW)"));
    expect(confirm).toHaveBeenNthCalledWith(2, expect.stringContaining("Build bootloader (task-2, IN_REVIEW)"));
    expect(putBodies).toHaveLength(3);
    expect(putBodies[0]?.["confirmedActiveTaskIds"]).toBeUndefined();
    expect(putBodies[1]?.["ticketSource"]).toEqual(putBodies[0]?.["ticketSource"]);
    expect(putBodies[1]?.["confirmedActiveTaskIds"]).toEqual(["task-1"]);
    expect(putBodies[2]?.["confirmedActiveTaskIds"]).toEqual(["task-2"]);
    expect(putBodies[2]?.["ticketSource"]).toEqual(putBodies[0]?.["ticketSource"]);
  });

  it("leaves the form unchanged without an error when active-task confirmation is cancelled", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      domainCapabilities: ["source_control", "issue_tracking"],
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let projectPutCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/projects/project-1/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200 });
      }
      if (path === "/api/admin/projects/project-1" && init?.method === "PUT") {
        projectPutCount++;
        return new Response(JSON.stringify({
          error: "Conflict",
          message: "Execution configuration changed",
          code: "ACTIVE_TASKS_CONFIRMATION_REQUIRED",
          activeTasks: [{ taskId: "task-1", ticketId: "TCK-9", ticketTitle: "Build firmware", taskType: "code-gen", state: "IN_REVIEW" }],
        }), { status: 409 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/runtime",
            cloneUrl: "https://gerrit.example.com/platform/runtime.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(projectPutCount).toBe(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Build firmware"));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("Project update was not saved.")).toBeNull();
  });

  it("fills an empty push target from a unique repository match", async () => {
    const integration = gerritIntegration("gerrit-1", "Primary Gerrit");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === "/api/admin/projects/resolve-repositories") {
        return new Response(JSON.stringify({
          repositories: [{
            cloneUrl: "https://gerrit.example.com/platform/runtime.git",
            localPath: ".",
            status: "matched",
            match: {
              integrationId: integration.id,
              integrationName: integration.name,
              provider: integration.provider,
              repoKey: "platform/runtime",
              enabled: true,
            },
            candidates: [],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.startsWith("/api/admin/integrations/gerrit-1/branches")) {
        return new Response(JSON.stringify({ branches: ["main"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cloneUrl = screen.getByLabelText(/Clone URL/);
    fireEvent.change(cloneUrl, { target: { value: "https://gerrit.example.com/platform/runtime.git" } });
    fireEvent.blur(cloneUrl);

    await waitFor(() => {
      expect(screen.getByLabelText(/VCS Integration/)).toHaveProperty("value", "gerrit-1");
    });
    expect(await screen.findByRole("button", { name: /Runtime/ })).toBeTruthy();
    expect(screen.getByText("Matched Primary Gerrit")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/projects/resolve-repositories",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repositories: [{
            cloneUrl: "https://gerrit.example.com/platform/runtime.git",
            localPath: ".",
          }],
        }),
      }),
    );
  });

  it("leaves an ambiguous repository unselected", async () => {
    const integrations = [
      gerritIntegration("gerrit-a", "Gerrit A"),
      gerritIntegration("gerrit-b", "Gerrit B"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      repositories: [{
        cloneUrl: "https://gerrit.example.com/platform/runtime.git",
        localPath: ".",
        status: "ambiguous",
        match: null,
        candidates: integrations.map((integration) => ({
          integrationId: integration.id,
          integrationName: integration.name,
          provider: integration.provider,
          repoKey: "platform/runtime",
          enabled: true,
        })),
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={integrations}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cloneUrl = screen.getByLabelText(/Clone URL/);
    fireEvent.change(cloneUrl, { target: { value: "https://gerrit.example.com/platform/runtime.git" } });
    fireEvent.blur(cloneUrl);

    expect(await screen.findByText("Multiple integrations match: Gerrit A, Gerrit B")).toBeTruthy();
    expect(screen.getByLabelText(/VCS Integration/)).toHaveProperty("value", "");
  });

  it("does not select a disabled integration without confirmation", async () => {
    const integration = { ...gerritIntegration("gerrit-1", "Primary Gerrit"), enabled: false };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      repositories: [{
        cloneUrl: "https://gerrit.example.com/platform/runtime.git",
        localPath: ".",
        status: "matched",
        match: {
          integrationId: integration.id,
          integrationName: integration.name,
          provider: integration.provider,
          repoKey: "platform/runtime",
          enabled: false,
        },
        candidates: [],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cloneUrl = screen.getByLabelText(/Clone URL/);
    fireEvent.change(cloneUrl, { target: { value: "https://gerrit.example.com/platform/runtime.git" } });
    fireEvent.blur(cloneUrl);

    expect(await screen.findByText("Match found in disabled integration Primary Gerrit; select it explicitly to continue")).toBeTruthy();
    expect(screen.getByLabelText(/VCS Integration/)).toHaveProperty("value", "");
  });

  it("tracks non-pushable scanned components as vendor components", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [{
          key: "platform/root",
          name: "Root",
          cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
          defaultBranch: "main",
        }],
      },
    };
    let savedComponents: Array<Record<string, unknown>> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({
          manifestFiles: ["kas/config.yaml"],
          repositories: [{
            cloneUrl: "https://git.yoctoproject.org/git/poky",
            localPath: "layers/poky",
            revision: "kirkstone",
            relation: "manifest_member",
            sourcePath: "kas/config.yaml",
            origin: "patch_required",
            resolution: null,
          }, {
            cloneUrl: "https://github.com/phytec/meta-phytec",
            localPath: "layers/meta-phytec",
            revision: "kirkstone",
            relation: "manifest_member",
            sourcePath: "kas/config.yaml",
            origin: "patch_required",
            resolution: null,
          }],
          diagnostics: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9" && init?.method === "PUT") {
        return new Response(JSON.stringify({ project: { id: "project-9" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9/vendor-components") {
        if (init?.method === "PUT") {
          savedComponents = (JSON.parse(String(init.body)) as { components: Array<Record<string, unknown>> }).components;
          return new Response(JSON.stringify({ components: savedComponents }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-9",
          name: "Yocto",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "yocto",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Patch layers/poky locally" }));
    fireEvent.click(await screen.findByRole("button", { name: "Patch layers/meta-phytec locally" }));

    fireEvent.click(screen.getByRole("button", { name: /Save|Create Project/ }));

    await waitFor(() => expect(savedComponents).toEqual([{
      sourcePath: "kas/config.yaml",
      localPath: "layers/poky",
      cloneUrl: "https://git.yoctoproject.org/git/poky",
      revision: "kirkstone",
      origin: "patch_required",
    }, {
      sourcePath: "kas/config.yaml",
      localPath: "layers/meta-phytec",
      cloneUrl: "https://github.com/phytec/meta-phytec",
      revision: "kirkstone",
      origin: "patch_required",
    }]));
  });

  it("keeps a component tracked while the initial load is still in flight", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [{
          key: "platform/root",
          name: "Root",
          cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
          defaultBranch: "main",
        }],
      },
    };
    let releaseLoad = (): void => {};
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let savedComponents: Array<Record<string, unknown>> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({
          manifestFiles: ["kas/config.yaml"],
          repositories: [{
            cloneUrl: "https://git.yoctoproject.org/git/poky",
            localPath: "layers/poky",
            revision: "kirkstone",
            relation: "manifest_member",
            sourcePath: "kas/config.yaml",
            origin: "patch_required",
            resolution: null,
          }],
          diagnostics: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9" && init?.method === "PUT") {
        return new Response(JSON.stringify({ project: { id: "project-9" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9/vendor-components") {
        if (init?.method === "PUT") {
          savedComponents = (JSON.parse(String(init.body)) as { components: Array<Record<string, unknown>> }).components;
          return new Response(JSON.stringify({ components: savedComponents }), { status: 200, headers: { "content-type": "application/json" } });
        }
        await loadGate;
        return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-9",
          name: "Yocto",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "yocto",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Patch layers/poky locally" }));
    await act(async () => {
      releaseLoad();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save|Create Project/ }));

    await waitFor(() => expect(savedComponents).toEqual([{
      sourcePath: "kas/config.yaml",
      localPath: "layers/poky",
      cloneUrl: "https://git.yoctoproject.org/git/poky",
      revision: "kirkstone",
      origin: "patch_required",
    }]));
  });

  it("offers local patching only for components no repository of ours owns", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [{
          key: "platform/root",
          name: "Root",
          cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
          defaultBranch: "main",
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestPath = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({
          manifestFiles: ["kas/config.yaml"],
          repositories: [{
            cloneUrl: "https://git.yoctoproject.org/git/poky",
            localPath: "layers/poky",
            revision: "kirkstone",
            relation: "manifest_member",
            sourcePath: "kas/config.yaml",
            origin: "patch_required",
            resolution: null,
          }, {
            cloneUrl: "https://gerrit.example.com/platform/vendored-fork.git",
            localPath: "layers/vendored-fork",
            revision: "kirkstone",
            relation: "manifest_member",
            sourcePath: "kas/config.yaml",
            origin: "fork_pushable",
            resolution: null,
          }],
          diagnostics: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-9",
          name: "Yocto",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "yocto",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));

    expect(await screen.findByRole("button", { name: "Patch layers/poky locally" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Patch layers/vendored-fork locally" })).toBeNull();
  });

  it("pushes a mirrored component to the repository the operator maps it to", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "g1.sfl.io"),
      discoveredResources: {
        repositories: [
          {
            key: "guardian-telecom/aura/yocto-build",
            name: "yocto-build",
            cloneUrlHttp: "https://g1.sfl.io/guardian-telecom/aura/yocto-build",
            defaultBranch: "main",
          },
          {
            key: "guardian-telecom/aura/Project-AURA-Application",
            name: "Project-AURA-Application",
            cloneUrlHttp: "https://g1.sfl.io/guardian-telecom/aura/Project-AURA-Application",
            defaultBranch: "main",
          },
        ],
      },
    };
    let savedPayload: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({
          manifestFiles: [".config.yaml"],
          repositories: [{
            // The recipe declares the GitHub mirror, which no VE integration owns.
            cloneUrl: "ssh://github.com/Guardian-Telecom-Ltd/Project-AURA-Application.git",
            localPath: "Project-AURA-Application",
            revision: "7ef2cb39d7087754c5b4d9389e2f89d9d3602d2a",
            relation: "manifest_member",
            sourcePath: "sources/meta-aura/recipes-app/aura-application/aura-application.bb",
            origin: "patch_required",
            resolution: null,
          }],
          diagnostics: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath.startsWith("/api/admin/integrations/gerrit-1/branches")) {
        return new Response(JSON.stringify({ branches: ["sfl/main", "main"] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9" && init?.method === "PUT") {
        savedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ project: { id: "project-9" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-9",
          name: "AURA",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "aura",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "guardian-telecom/aura/yocto-build",
            cloneUrl: "https://g1.sfl.io/guardian-telecom/aura/yocto-build",
            targetBranch: "sfl/main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));

    fireEvent.click(await screen.findByRole("button", { name: "Add Project-AURA-Application as push target" }));

    const vcsSelects = screen.getAllByLabelText(/VCS Integration/);
    fireEvent.change(vcsSelects[vcsSelects.length - 1]!, { target: { value: "gerrit-1" } });

    const repositoryPickers = await screen.findAllByRole("button", { name: "— select —" });
    fireEvent.click(repositoryPickers[repositoryPickers.length - 1]!);
    fireEvent.click(await screen.findByRole("button", { name: /^Project-AURA-Application · main/ }));

    fireEvent.click(await screen.findByRole("button", { name: /Save|Create Project/ }));

    await waitFor(() => expect(savedPayload).not.toBeNull());
    const targets = (savedPayload as unknown as { pushTargets: Array<Record<string, unknown>> }).pushTargets;
    expect(targets).toHaveLength(2);
    expect(targets[1]).toMatchObject({
      integrationId: "gerrit-1",
      repoKey: "guardian-telecom/aura/Project-AURA-Application",
      // The Gerrit clone URL replaces the GitHub mirror the recipe declared.
      cloneUrl: "https://g1.sfl.io/guardian-telecom/aura/Project-AURA-Application",
      targetBranch: "main",
    });
    expect(String(targets[1]?.["cloneUrl"])).not.toContain("github.com");
  });

  it("does not offer tracking for internal members, whose notes would never reach the agent", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [{
          key: "platform/root",
          name: "Root",
          cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
          defaultBranch: "main",
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestPath = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({
          manifestFiles: ["kas/config.yaml"],
          repositories: [{
            cloneUrl: null,
            localPath: "meta-product",
            revision: null,
            relation: "contains",
            sourcePath: "kas/config.yaml",
            origin: "internal",
            resolution: null,
          }],
          diagnostics: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath === "/api/admin/projects/project-9/vendor-components") {
        return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-9",
          name: "Yocto",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "yocto",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));

    expect(await screen.findByText("meta-product")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Patch .* locally$/ })).toBeNull();
  });

  it("shows scan progress and adds a matched member only after explicit selection", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [
          {
            key: "platform/root",
            name: "Root",
            cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
            defaultBranch: "main",
          },
          {
            key: "platform/runtime",
            name: "Runtime",
            cloneUrlHttp: "https://gerrit.example.com/platform/runtime.git",
            defaultBranch: "main",
          },
        ],
      },
    };
    let savedPushTargets: Array<Record<string, unknown>> = [];
    let finishScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => { finishScan = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        await scanGate;
        return new Response(JSON.stringify({
          manifestFiles: [".gitmodules", "platform.code-workspace"],
          repositories: [
            {
              cloneUrl: "https://gerrit.example.com/platform/runtime.git",
              localPath: "libs/runtime",
              revision: "refs/heads/stable",
              relation: "gitlink",
              sourcePath: ".gitmodules",
              resolution: {
                cloneUrl: "https://gerrit.example.com/platform/runtime.git",
                localPath: "libs/runtime",
                status: "matched",
                match: {
                  integrationId: "gerrit-1",
                  integrationName: "Primary Gerrit",
                  provider: "gerrit",
                  repoKey: "platform/runtime",
                  enabled: true,
                },
                candidates: [],
              },
            },
            {
              cloneUrl: null,
              localPath: "services/api",
              revision: null,
              relation: "contains",
              sourcePath: "platform.code-workspace",
              resolution: null,
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              cloneUrl: null,
              localPath: `contrib/dependency-${index + 1}`,
              revision: null,
              relation: "manifest_member",
              sourcePath: `contrib/dependency-${index + 1}/package.json`,
              resolution: null,
            })),
          ],
          diagnostics: [{
            sourcePath: "platform.code-workspace",
            severity: "warning",
            message: "Workspace folder 'services/api' does not declare a repository URL and requires manual binding.",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requestPath.startsWith("/api/admin/integrations/gerrit-1/branches")) {
        return new Response(JSON.stringify({ branches: ["stable", "release"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestPath === "/api/admin/projects/project-1" && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body)) as { pushTargets: Array<Record<string, unknown>> };
        savedPushTargets = payload.pushTargets;
        return new Response(JSON.stringify({ project: { id: "project-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));
    const scanningButton = screen.getByRole("button", { name: "Scanning…" });
    expect(scanningButton.querySelector("svg")?.classList.contains("spin")).toBe(true);
    finishScan?.();

    expect(await screen.findByText("2 manifests · 7 members detected")).toBeTruthy();
    const memberList = screen.getByTestId("workspace-members-scroll");
    expect(memberList.style.maxHeight).toBe("296px");
    expect(memberList.style.overflowY).toBe("auto");
    const memberSearch = screen.getByLabelText("Search detected members");
    fireEvent.change(memberSearch, { target: { value: "services/api" } });
    expect(screen.getByText("services/api")).toBeTruthy();
    expect(screen.queryByText("libs/runtime")).toBeNull();
    fireEvent.change(memberSearch, { target: { value: "" } });
    expect(screen.getByText("libs/runtime")).toBeTruthy();
    expect(screen.getByText("services/api")).toBeTruthy();
    expect(screen.getByText("Push Targets (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add libs/runtime as push target" }));
    await waitFor(() => expect(screen.getByText("Push Targets (2)")).toBeTruthy());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "libs/runtime added" }).disabled).toBe(true);
    expect(screen.queryByLabelText("Role")).toBeNull();
    expect(screen.queryByLabelText("Commit Order")).toBeNull();
    expect(screen.queryByLabelText(/Local Path/)).toBeNull();
    const cloneUrls = screen.getAllByLabelText(/Clone URL/) as HTMLInputElement[];
    expect(cloneUrls.map((input) => input.value)).toContain("https://gerrit.example.com/platform/runtime.git");

    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => expect(screen.getByText("Push Targets (2)")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedPushTargets).toHaveLength(2));
    expect(savedPushTargets).toEqual([
      expect.objectContaining({ localPath: ".", role: "primary", commitOrder: 1 }),
      expect.objectContaining({ localPath: "libs/runtime", targetBranch: "stable", role: "submodule", commitOrder: 2 }),
    ]);
  });

  it("derives collision-free local paths for manually selected repositories", async () => {
    const integration = gerritIntegration("gerrit-1", "Primary Gerrit");
    let savedPushTargets: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath.startsWith("/api/admin/integrations/gerrit-1/branches")) {
        return new Response(JSON.stringify({ branches: ["main"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestPath === "/api/admin/projects/project-1" && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body)) as { pushTargets: Array<Record<string, unknown>> };
        savedPushTargets = payload.pushTargets;
        return new Response(JSON.stringify({ project: { id: "project-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "release/custom",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    for (const repositoryNumber of [2, 3]) {
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      const repositoryCard = screen.getByText(`Repository #${repositoryNumber}`).parentElement?.parentElement;
      expect(repositoryCard).not.toBeNull();
      const repository = within(repositoryCard!);
      fireEvent.change(repository.getByLabelText(/VCS Integration/), { target: { value: integration.id } });
      fireEvent.click(await repository.findByRole("button", { name: "— select —" }));
      fireEvent.click(repository.getByRole("button", { name: /Runtime/ }));
    }

    expect(screen.queryByLabelText(/Local Path/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedPushTargets).toHaveLength(3));
    expect(savedPushTargets.map((target) => target["localPath"])).toEqual([".", "runtime", "runtime-2"]);
    expect(savedPushTargets[0]?.["targetBranch"]).toBe("release/custom");
  });

  it("does not show a workspace scan error after the target URL changes", async () => {
    const integration: ApiIntegration = {
      ...gerritIntegration("gerrit-1", "Primary Gerrit"),
      discoveredResources: {
        repositories: [{
          key: "platform/root",
          name: "Root",
          cloneUrlHttp: "https://gerrit.example.com/platform/root.git",
          defaultBranch: "main",
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const requestPath = String(input);
      if (requestPath.startsWith("/api/admin/integrations/gerrit-1/branches")) {
        return new Response(JSON.stringify({ branches: ["main"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestPath === "/api/admin/projects/scan-push-targets") {
        return new Response(JSON.stringify({ error: "Original repository scan failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    }));

    render(
      <ProjectFormModal
        agents={[codingAgent]}
        integrations={[integration]}
        project={{
          id: "project-1",
          name: "Platform",
          type: "coding",
          agentId: codingAgent.id,
          ticketSource: {
            integration: { id: integration.id, name: integration.name, provider: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "primary",
            commitOrder: 1,
            localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Scan workspace" }));
    expect(await screen.findByText("Original repository scan failed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Clone URL/), {
      target: { value: "https://gerrit.example.com/platform/other.git" },
    });

    expect(screen.queryByText("Original repository scan failed")).toBeNull();
  });

  it("hydrates the automatic reviewer assignment mode for review projects", () => {
    const reviewAgent: ApiAgent = {
      ...codingAgent,
      id: "review-agent-1",
      name: "Review agent",
      type: "review",
    };
    const reviewIntegration: ApiIntegration = {
      id: "github-1",
      provider: "github",
      name: "GitHub",
      enabled: true,
      capabilities: [],
      domainCapabilities: ["code_review"],
      reviewAssignmentModes: ["manual", "automatic"],
      discoveredResources: {
        repositories: [{ key: "octocat/repo", name: "Repo" }],
      },
    };

    render(
      <ProjectFormModal
        agents={[reviewAgent]}
        integrations={[reviewIntegration]}
        project={{
          id: "review-project-1",
          name: "Review project",
          type: "review",
          agentId: reviewAgent.id,
          reviewConfig: {
            integration: { id: reviewIntegration.id, name: reviewIntegration.name, provider: reviewIntegration.provider },
            repos: ["octocat/repo"],
            assignmentMode: "automatic",
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Reviewer assignment")).toHaveProperty("value", "automatic");
  });

  it("hydrates, edits, and submits the review branch list for review projects", async () => {
    const reviewAgent: ApiAgent = { ...codingAgent, id: "review-agent-1", name: "Review agent", type: "review" };
    const reviewIntegration: ApiIntegration = {
      id: "gerrit-review",
      provider: "gerrit",
      name: "Gerrit",
      enabled: true,
      capabilities: [],
      domainCapabilities: ["code_review"],
      reviewAssignmentModes: ["manual", "automatic"],
      discoveredResources: { repositories: [{ key: "platform/api", name: "API" }] },
    };
    let savedReviewConfig: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/projects/review-project-1" && init?.method === "PUT") {
        savedReviewConfig = (JSON.parse(String(init.body)) as { reviewConfig: Record<string, unknown> }).reviewConfig;
        return new Response(JSON.stringify({ project: { id: "review-project-1" } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(
      <ProjectFormModal
        agents={[reviewAgent]}
        integrations={[reviewIntegration]}
        project={{
          id: "review-project-1",
          name: "Review project",
          type: "review",
          agentId: reviewAgent.id,
          reviewConfig: {
            integration: { id: reviewIntegration.id, name: reviewIntegration.name, provider: reviewIntegration.provider },
            repos: ["platform/api"],
            assignmentMode: "manual",
            branches: ["main"],
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const branches = screen.getByLabelText("Branches to review");
    expect(branches).toHaveProperty("value", "main");
    fireEvent.change(branches, { target: { value: "main, python, " } });
    expect(branches).toHaveProperty("value", "main, python, ");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(savedReviewConfig).toBeDefined());
    expect(savedReviewConfig?.["branches"]).toEqual(["main", "python"]);
  });

  describe("dependent fields", () => {
    function ticketingIntegration(id: string): ApiIntegration {
      return { id, provider: "redmine", name: id, enabled: true, capabilities: [], domainCapabilities: ["issue_tracking"] };
    }

    function reviewIntegration(id: string, modes: Array<"manual" | "automatic">): ApiIntegration {
      return {
        id, provider: "github", name: id, enabled: true, capabilities: [], domainCapabilities: ["code_review"],
        reviewAssignmentModes: modes,
        discoveredResources: { repositories: [{ key: `${id}/repo`, name: "Repo" }] },
      };
    }

    it("reveals the ticket project key and ticket options after choosing a ticket source, clearing them on change", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), {
        status: 502, headers: { "content-type": "application/json" },
      })));
      render(<ProjectFormModal agents={[codingAgent]} integrations={[ticketingIntegration("t1"), ticketingIntegration("t2")]} onClose={vi.fn()} onSaved={vi.fn()} />);

      expect(screen.queryByText("Ticket Project Key")).toBeNull();
      expect(screen.queryByText("Ticket URL in Commits")).toBeNull();
      expect(screen.queryByText("Post Review Link to Ticket")).toBeNull();

      const ticketing = screen.getByRole("combobox", { name: /Ticketing Integration/ });
      fireEvent.change(ticketing, { target: { value: "t1" } });
      const key = await screen.findByPlaceholderText("PROJECT_KEY");
      fireEvent.change(key, { target: { value: "ABC" } });
      expect(screen.getByText("Ticket URL in Commits")).toBeTruthy();
      expect(screen.getByText("Post Review Link to Ticket")).toBeTruthy();
      fireEvent.click(screen.getByLabelText("Include full ticket URL in commit message footers"));
      fireEvent.click(screen.getByLabelText("Post a ticket comment with the review link(s)"));

      fireEvent.change(ticketing, { target: { value: "t2" } });
      expect(await screen.findByPlaceholderText("PROJECT_KEY")).toHaveProperty("value", "");
      expect(screen.getByLabelText("Include full ticket URL in commit message footers")).toHaveProperty("checked", false);
      expect(screen.getByLabelText("Post a ticket comment with the review link(s)")).toHaveProperty("checked", false);
      fireEvent.change(ticketing, { target: { value: "" } });
      expect(screen.queryByText("Ticket URL in Commits")).toBeNull();
      expect(screen.queryByText("Post Review Link to Ticket")).toBeNull();
    });

    it("reveals repository, branch, and Gerrit topic fields step by step and resets them on integration change", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ branches: ["main"] }), {
        status: 200, headers: { "content-type": "application/json" },
      })));
      render(<ProjectFormModal
        agents={[codingAgent]}
        integrations={[gerritIntegration("gerrit-1", "Gerrit 1"), gerritIntegration("gerrit-2", "Gerrit 2")]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />);

      expect(screen.queryByText("Repository Key")).toBeNull();
      expect(screen.queryByText("Target Branch")).toBeNull();
      expect(screen.queryByText("Custom Gerrit Topic")).toBeNull();
      expect(screen.getByLabelText(/Clone URL/)).toBeTruthy();

      const vcs = screen.getByLabelText(/VCS Integration/);
      fireEvent.change(vcs, { target: { value: "gerrit-1" } });
      expect(screen.getByText("Repository Key")).toBeTruthy();
      expect(screen.getByText("Custom Gerrit Topic")).toBeTruthy();
      expect(screen.queryByText("Target Branch")).toBeNull();

      fireEvent.click(await screen.findByRole("button", { name: "— select —" }));
      fireEvent.click(screen.getByRole("button", { name: /Runtime/ }));
      expect(await screen.findByText("Target Branch")).toBeTruthy();
      expect(screen.getByLabelText(/Clone URL/)).toHaveProperty("value", "ssh://git@gerrit.example.com:29418/platform/runtime.git");

      fireEvent.change(vcs, { target: { value: "gerrit-2" } });
      expect(screen.queryByText("Target Branch")).toBeNull();
      expect(screen.getByLabelText(/Clone URL/)).toHaveProperty("value", "");
    });

    it("reveals review assignment and repositories after choosing a review integration, resetting them on change", () => {
      const reviewAgent: ApiAgent = { ...codingAgent, id: "review-agent", type: "review" };
      render(<ProjectFormModal
        agents={[reviewAgent]}
        integrations={[reviewIntegration("r1", ["manual", "automatic"]), reviewIntegration("r2", ["manual", "automatic"])]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />);
      fireEvent.change(screen.getByRole("combobox", { name: /^Type/ }), { target: { value: "review" } });

      expect(screen.queryByText("Reviewer assignment")).toBeNull();
      expect(screen.queryByText("Repository Keys")).toBeNull();

      const integration = screen.getByRole("combobox", { name: /Review Integration/ });
      fireEvent.change(integration, { target: { value: "r1" } });
      fireEvent.change(screen.getByLabelText("Reviewer assignment"), { target: { value: "automatic" } });
      expect(screen.getByText("Repository Keys")).toBeTruthy();

      fireEvent.change(integration, { target: { value: "r2" } });
      expect(screen.getByLabelText("Reviewer assignment")).toHaveProperty("value", "manual");
    });

    it("shows additional skills only for an agent whose engine installs them", () => {
      const integrations: ApiIntegration[] = [
        { id: "aider-1", provider: "aider", name: "Aider", enabled: true, capabilities: [], domainCapabilities: ["agent_execution"] },
        { id: "claude-1", provider: "claude", name: "Claude", enabled: true, capabilities: [], domainCapabilities: ["agent_execution"] },
      ];
      const agents = [
        { ...codingAgent, id: "aider-agent", integrationId: "aider-1" },
        { ...codingAgent, id: "claude-agent", integrationId: "claude-1" },
      ];
      render(<ProjectFormModal agents={agents} integrations={integrations} onClose={vi.fn()} onSaved={vi.fn()} />);
      const agent = screen.getByRole("combobox", { name: /^Agent/ });

      expect(screen.queryByText("Additional Skills")).toBeNull();
      fireEvent.change(agent, { target: { value: "aider-agent" } });
      expect(screen.queryByText("Additional Skills")).toBeNull();
      fireEvent.change(agent, { target: { value: "claude-agent" } });
      expect(screen.getByText("Additional Skills")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Add source" }));
      fireEvent.change(agent, { target: { value: "aider-agent" } });
      expect(screen.queryByText("Additional Skills")).toBeNull();
      fireEvent.change(agent, { target: { value: "claude-agent" } });
      expect(screen.queryByText("Source", { selector: "label" })).toBeNull();
    });

    it("hydrates missing integration IDs and preserves saved dependent values on initial edit", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ components: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      })));
      render(<ProjectFormModal
        agents={[codingAgent]}
        integrations={[]}
        project={{
          id: "legacy", name: "Legacy", type: "coding", agentId: codingAgent.id,
          skillSources: [{ source: "skills.git", skills: [], installAll: true }],
          ticketSource: { integration: null, ticketProjectKey: "OLD" },
          useFullTicketUrlInCommits: true, postReviewLinkToTicket: true,
          gerritTopicOverride: "legacy-topic",
          pushTargets: [{
            integrationId: null, repoKey: "old/repo", cloneUrl: "https://example.com/repo.git",
            targetBranch: "main", role: "primary", commitOrder: 0, localPath: ".",
          }],
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />);
      await waitFor(() => expect(screen.getByLabelText(/VCS Integration/)).toHaveProperty("value", ""));
      expect(screen.getByText("Additional Skills")).toBeTruthy();
      expect(screen.getByLabelText("Custom Gerrit Topic")).toHaveProperty("value", "legacy-topic");
      expect(screen.getByLabelText("Include full ticket URL in commit message footers")).toHaveProperty("checked", true);
      expect(screen.getByLabelText("Post a ticket comment with the review link(s)")).toHaveProperty("checked", true);
    });

    it("hides and clears the topic after the last Gerrit push target is changed or removed", () => {
      const gerrit = gerritIntegration("gerrit-1", "Gerrit");
      const gitlab: ApiIntegration = { ...gerrit, id: "gitlab-1", name: "GitLab", provider: "gitlab" };
      render(<ProjectFormModal agents={[codingAgent]} integrations={[gerrit, gitlab]} onClose={vi.fn()} onSaved={vi.fn()} />);
      const vcs = screen.getByLabelText(/VCS Integration/);
      fireEvent.change(vcs, { target: { value: gerrit.id } });
      fireEvent.change(screen.getByLabelText("Custom Gerrit Topic"), { target: { value: "topic" } });
      fireEvent.change(vcs, { target: { value: gitlab.id } });
      expect(screen.queryByText("Custom Gerrit Topic")).toBeNull();
      fireEvent.change(vcs, { target: { value: gerrit.id } });
      expect(screen.getByLabelText("Custom Gerrit Topic")).toHaveProperty("value", "");
      fireEvent.change(screen.getByLabelText("Custom Gerrit Topic"), { target: { value: "again" } });
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      const firstCard = screen.getByText("Repository #1").parentElement?.parentElement;
      fireEvent.click(within(firstCard!).getByRole("button", { name: "" }));
      expect(screen.queryByText("Custom Gerrit Topic")).toBeNull();
    });
  });
});
