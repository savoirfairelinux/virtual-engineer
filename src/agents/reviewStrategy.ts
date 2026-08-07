import type { AgentType, ReviewStrategy } from "../interfaces.js";
import type { ReviewStrategyDescriptor } from "../plugins/registry.js";
import { resolveProviderOptions } from "./providerOptions.js";

export interface ReviewStrategyConfigInput {
  agentType: AgentType;
  modelConfig: Record<string, unknown>;
  systemPromptId: string;
  feedbackInstructionsPromptId: string | null;
  providerName: string | null;
  supportedStrategies: readonly ReviewStrategyDescriptor[];
}

export interface ReviewStrategyConfigResult {
  reviewStrategy: ReviewStrategy;
  modelConfig: Record<string, unknown>;
  feedbackInstructionsPromptId: string | null;
}

export class ReviewStrategyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewStrategyConfigError";
  }
}

export function resolveReviewStrategy(modelConfig: Record<string, unknown>): ReviewStrategy {
  const value = resolveProviderOptions(modelConfig)["reviewStrategy"];
  if (value === undefined || value === "ve_direct") return "ve_direct";
  if (value === "copilot_native") return "copilot_native";
  throw new ReviewStrategyConfigError(`Unknown review strategy '${typeof value === "string" ? value : JSON.stringify(value)}'`);
}

export function normalizeReviewStrategyConfig(
  input: ReviewStrategyConfigInput
): ReviewStrategyConfigResult {
  const reviewStrategy = resolveReviewStrategy(input.modelConfig);
  if (reviewStrategy === "ve_direct") {
    return {
      reviewStrategy,
      modelConfig: input.modelConfig,
      feedbackInstructionsPromptId: input.feedbackInstructionsPromptId,
    };
  }

  if (input.agentType !== "review") {
    throw new ReviewStrategyConfigError("Copilot native review is only available for review agents");
  }

  const descriptor = input.supportedStrategies.find(({ id }) => id === reviewStrategy);
  if (!descriptor) {
    throw new ReviewStrategyConfigError(
      `Provider '${input.providerName ?? "unlinked"}' does not support review strategy '${reviewStrategy}'`
    );
  }
  if (input.systemPromptId !== descriptor.requiredSystemPromptId) {
    throw new ReviewStrategyConfigError(
      `Review strategy '${reviewStrategy}' requires agent instructions '${descriptor.requiredSystemPromptId}'`
    );
  }

  const modelConfig = { ...input.modelConfig };
  delete modelConfig["model"];
  const providerOptions = resolveProviderOptions(modelConfig);
  delete providerOptions["reasoningEffort"];
  providerOptions["reviewStrategy"] = reviewStrategy;
  modelConfig["providerOptions"] = providerOptions;

  return {
    reviewStrategy,
    modelConfig,
    feedbackInstructionsPromptId: null,
  };
}