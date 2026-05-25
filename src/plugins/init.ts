/**
 * Built-in plugin registration.
 *
 * Must be called once — before `PluginManager.loadFromDatabase()` — to make
 * all built-in integration types discoverable by the plugin manager.
 */
import { registerPlugin } from "./registry.js";
import { redmineDescriptor } from "./descriptors/redmine.js";
import { gerritDescriptor } from "./descriptors/gerrit.js";
import { gitlabIssueDescriptor } from "./descriptors/gitlab-issue.js";
import { gitlabMergeRequestDescriptor } from "./descriptors/gitlab-merge-request.js";
import { createCopilotDescriptor } from "./descriptors/copilot.js";
import { mockDescriptor } from "./descriptors/mock.js";
import { githubIssueDescriptor } from "./descriptors/github-issue.js";
import { githubPullRequestDescriptor } from "./descriptors/github-pull-request.js";

/** Register all built-in integration descriptors with the plugin registry. */
export function registerBuiltinPlugins(options?: { adminAuthSecret?: string }): void {
  registerPlugin(redmineDescriptor);
  registerPlugin(gerritDescriptor);
  registerPlugin(gitlabIssueDescriptor);
  registerPlugin(gitlabMergeRequestDescriptor);
  registerPlugin(createCopilotDescriptor(options?.adminAuthSecret));
  registerPlugin(mockDescriptor);
  registerPlugin(githubIssueDescriptor);
  registerPlugin(githubPullRequestDescriptor);
}
