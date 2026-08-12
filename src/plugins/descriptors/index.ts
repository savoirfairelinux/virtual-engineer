/**
 * Built-in provider descriptor aggregation.
 *
 * Adding a new provider should be a matter of importing its descriptor here and
 * appending it to the returned array (plus extending the `ProviderId` union).
 */
import type { ProviderDescriptor } from "../registry.js";
import { redmineDescriptor } from "./redmine.js";
import { gerritDescriptor } from "./gerrit.js";
import { gitlabDescriptor } from "./gitlab.js";
import { createCopilotDescriptor } from "./copilot.js";
import { createClaudeDescriptor } from "./claude.js";
import { createAiderDescriptor } from "./aider.js";
import { createGooseDescriptor } from "./goose.js";
import { createCodexDescriptor } from "./codex.js";
import { createOpenCodeDescriptor } from "./opencode.js";
import { createCursorDescriptor } from "./cursor.js";
import { mockDescriptor } from "./mock.js";
import { githubDescriptor } from "./github.js";

/** Return all built-in provider descriptors in their registration order. */
export function buildBuiltinDescriptors(options?: { adminAuthSecret?: string }): ProviderDescriptor[] {
  return [
    redmineDescriptor,
    gerritDescriptor,
    gitlabDescriptor,
    createCopilotDescriptor(options?.adminAuthSecret),
    createClaudeDescriptor(options?.adminAuthSecret),
    createAiderDescriptor(options?.adminAuthSecret),
    createGooseDescriptor(options?.adminAuthSecret),
    createCodexDescriptor(options?.adminAuthSecret),
    createOpenCodeDescriptor(options?.adminAuthSecret),
    createCursorDescriptor(options?.adminAuthSecret),
    mockDescriptor,
    githubDescriptor,
  ];
}
