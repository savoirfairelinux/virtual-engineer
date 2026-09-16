import type {
  AgentAdapter,
  ProjectRecord,
} from "../interfaces.js";
import { resolveAgentConfig } from "../state/stateStore.js";
import type { ProjectAgentRuntime } from "./agentContextBuilder.js";
import { resolveIntegrationConfig } from "./integrationConfig.js";
import type { ProjectModeDeps } from "./projectMode.js";

export interface AgentRuntimeResolverDependencies {
  getProjectMode: () => ProjectModeDeps | null;
}

/** Resolves a project agent adapter and its provider-specific runtime config. */
export class AgentRuntimeResolver {
  constructor(private readonly dependencies: AgentRuntimeResolverDependencies) {}

  async resolve(project: ProjectRecord | null): Promise<ProjectAgentRuntime> {
    const projectMode = this.dependencies.getProjectMode();
    if (!project || !projectMode) {
      throw new Error("Project agent runtime cannot be resolved outside project mode");
    }

    const agent = await projectMode.projectStore.getAgentById(project.agentId);
    if (!agent) {
      throw new Error(`Project agent ${project.agentId} was not found for project ${project.id}`);
    }
    if (!agent.enabled || agent.type !== "coding") {
      throw new Error(`Project agent ${agent.id} is not an enabled coding agent for project ${project.id}`);
    }
    if (!agent.integrationId) {
      throw new Error(`Project agent ${agent.id} has no agent integration configured`);
    }

    const adapter = projectMode.pluginManager.getConnectorForIntegration<AgentAdapter>(agent.integrationId);
    if (!adapter) {
      throw new Error(
        `Project agent adapter is unavailable for agent ${agent.id} `
        + `(integration ${agent.integrationId}, project ${project.id})`,
      );
    }

    const resolvedConfig = resolveAgentConfig(agent, project);
    let encryptedSessionToken = resolvedConfig.encryptedSessionToken;
    let apiKey = resolvedConfig.apiKey;
    const extra: Record<string, unknown> = { ...resolvedConfig.extra };
    if (!encryptedSessionToken || !apiKey || Object.keys(extra).length === 0) {
      const integration = projectMode.pluginManager.getActiveIntegrationById?.(agent.integrationId);
      if (integration) {
        const integrationConfig = resolveIntegrationConfig(projectMode, integration);
        if (integration.provider === "claude") {
          if (integrationConfig["authMode"] === "api_key") {
            if (!apiKey) {
              const key = integrationConfig["apiKey"];
              if (typeof key === "string" && key) apiKey = key;
            }
          } else if (!encryptedSessionToken) {
            const sessionToken = integrationConfig["sessionToken"];
            if (typeof sessionToken === "string" && sessionToken) {
              encryptedSessionToken = sessionToken;
            }
          }
        } else if (integration.provider === "codex") {
          if (integrationConfig["authMode"] === "api_key") {
            if (!apiKey) {
              const key = integrationConfig["apiKey"];
              if (typeof key === "string" && key) apiKey = key;
            }
          } else if (!encryptedSessionToken) {
            const accessToken = integrationConfig["accessToken"];
            if (typeof accessToken === "string" && accessToken) {
              encryptedSessionToken = accessToken;
            }
          }
        } else if (integration.provider === "cursor") {
          if (!apiKey) {
            const key = integrationConfig["apiKey"];
            if (typeof key === "string" && key) apiKey = key;
          }
        } else if (integration.provider === "aider") {
          const backend = integrationConfig["aiderBackend"];
          const key = integrationConfig["aiderApiKey"];
          const base = integrationConfig["aiderApiBase"];
          if (typeof backend === "string" && backend) extra["aiderBackend"] = backend;
          if (typeof key === "string" && key) extra["aiderApiKey"] = key;
          if (typeof base === "string" && base) extra["aiderApiBase"] = base;
        } else if (integration.provider === "goose") {
          const provider = integrationConfig["gooseProvider"];
          const key = integrationConfig["gooseApiKey"];
          const base = integrationConfig["gooseApiBase"];
          if (typeof provider === "string" && provider) extra["gooseProvider"] = provider;
          if (typeof key === "string" && key) extra["gooseApiKey"] = key;
          if (typeof base === "string" && base) extra["gooseApiBase"] = base;
        } else if (integration.provider === "gemini") {
          if (!apiKey) {
            const key = integrationConfig["apiKey"];
            if (typeof key === "string" && key) apiKey = key;
          }
          const authMode = integrationConfig["authMode"];
          const cloudProject = integrationConfig["googleCloudProject"];
          const cloudLocation = integrationConfig["googleCloudLocation"];
          if (typeof authMode === "string" && authMode) extra["geminiAuthMode"] = authMode;
          if (typeof cloudProject === "string" && cloudProject) {
            extra["geminiGoogleCloudProject"] = cloudProject;
          }
          if (typeof cloudLocation === "string" && cloudLocation) {
            extra["geminiGoogleCloudLocation"] = cloudLocation;
          }
        } else if (integration.provider === "opencode") {
          const provider = integrationConfig["openCodeProvider"];
          const key = integrationConfig["openCodeApiKey"];
          const base = integrationConfig["openCodeApiBase"];
          if (typeof provider === "string" && provider) extra["openCodeProvider"] = provider;
          if (typeof key === "string" && key) extra["openCodeApiKey"] = key;
          if (typeof base === "string" && base) extra["openCodeApiBase"] = base;
        } else if (!encryptedSessionToken) {
          const sessionToken = integrationConfig["sessionToken"];
          if (typeof sessionToken === "string" && sessionToken) {
            encryptedSessionToken = sessionToken;
          } else if (integrationConfig["authMode"] === "pat") {
            const personalAccessToken = integrationConfig["token"];
            if (!apiKey && typeof personalAccessToken === "string" && personalAccessToken) {
              apiKey = personalAccessToken;
            }
          }
        }
      }
    }

    const authChanged =
      encryptedSessionToken !== resolvedConfig.encryptedSessionToken
      || apiKey !== resolvedConfig.apiKey
      || Object.keys(extra).length > 0;
    return {
      adapter,
      config: authChanged
        ? { ...resolvedConfig, encryptedSessionToken, apiKey, extra }
        : resolvedConfig,
    };
  }
}