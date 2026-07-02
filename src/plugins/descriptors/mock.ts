import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { MockAgentAdapter } from "../../agents/mockAgentAdapter.js";

export const mockConfigSchema = z.object({
  status: z.enum(["success", "no_change", "failed"]).default("success"),
  simulateDelayMs: z.coerce.number().int().nonnegative().default(0),
});

export type MockPluginConfig = z.infer<typeof mockConfigSchema>;

export const mockDescriptor: ProviderDescriptor = {
  provider: "mock",
  name: "Mock Agent",
  configSchema: mockConfigSchema,
  requiredFields: [
    { key: "status", label: "Default Status", type: "text", required: false, placeholder: "success" },
    { key: "simulateDelayMs", label: "Simulated Delay (ms)", type: "number", required: false, placeholder: "0" },
  ],
  getSummaryDetails(_config) {
    return [];
  },
  capabilities: {
    agent_execution: {
      createAdapter: (config) => new MockAgentAdapter(config as ConstructorParameters<typeof MockAgentAdapter>[0]),
    },
  },
};
