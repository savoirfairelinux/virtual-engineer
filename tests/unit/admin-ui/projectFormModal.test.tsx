/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFormModal } from "../../../src/admin/ui/views/ConfigView/ProjectFormModal.js";
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
            integration: { id: integration.id, name: integration.name, type: integration.provider },
            ticketProjectKey: "platform",
          },
          pushTargets: [{
            integrationId: integration.id,
            repoKey: "platform/root",
            cloneUrl: "https://gerrit.example.com/platform/root.git",
            targetBranch: "main",
            role: "related",
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
    expect(memberList.style.maxHeight).toBe("276px");
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
            integration: { id: integration.id, name: integration.name, type: integration.provider },
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
  });
});