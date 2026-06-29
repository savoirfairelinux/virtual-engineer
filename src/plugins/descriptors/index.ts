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
import { mockDescriptor } from "./mock.js";
import { githubDescriptor } from "./github.js";

/** Return all built-in provider descriptors in their registration order. */
export function buildBuiltinDescriptors(options?: { adminAuthSecret?: string }): ProviderDescriptor[] {
  return [
    redmineDescriptor,
    gerritDescriptor,
    gitlabDescriptor,
    createCopilotDescriptor(options?.adminAuthSecret),
    mockDescriptor,
    githubDescriptor,
  ];
}
