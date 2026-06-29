import { describe, it, expect } from "vitest";
import {
  getHandlerForProviderEvent,
  getSupportedEventsForProvider,
  providerHasWebhookHandler,
} from "../../src/webhooks/handlers/index.js";
import { githubPullRequestWebhookHandler } from "../../src/webhooks/handlers/github-pull-request.js";
import { gitlabIssueWebhookHandler } from "../../src/webhooks/handlers/gitlab-issue.js";
import { gitlabMergeRequestWebhookHandler } from "../../src/webhooks/handlers/gitlab-merge-request.js";
import { redmineWebhookHandler } from "../../src/webhooks/handlers/redmine.js";

describe("getHandlerForProviderEvent()", () => {
  it("routes a supported event to its handler", () => {
    expect(getHandlerForProviderEvent("github", "github")).toBe(githubPullRequestWebhookHandler);
    expect(getHandlerForProviderEvent("redmine", "issue.created")).toBe(redmineWebhookHandler);
    expect(getHandlerForProviderEvent("gitlab", "issue")).toBe(gitlabIssueWebhookHandler);
    expect(getHandlerForProviderEvent("gitlab", "merge_request")).toBe(gitlabMergeRequestWebhookHandler);
    expect(getHandlerForProviderEvent("gitlab", "note")).toBe(gitlabMergeRequestWebhookHandler);
  });

  it("returns undefined for an unsupported event instead of mis-routing to the first handler", () => {
    expect(getHandlerForProviderEvent("github", "totally-unknown")).toBeUndefined();
    expect(getHandlerForProviderEvent("gitlab", "pipeline")).toBeUndefined();
    expect(getHandlerForProviderEvent("redmine", "issue")).toBeUndefined();
  });

  it("returns undefined when the event is missing", () => {
    expect(getHandlerForProviderEvent("github")).toBeUndefined();
    expect(getHandlerForProviderEvent("redmine", "")).toBeUndefined();
  });

  it("returns undefined for an unsupported provider", () => {
    expect(getHandlerForProviderEvent("gerrit", "patchset-created")).toBeUndefined();
    expect(getHandlerForProviderEvent("nope", "x")).toBeUndefined();
  });
});

describe("providerHasWebhookHandler() / getSupportedEventsForProvider()", () => {
  it("reports providers with handlers", () => {
    expect(providerHasWebhookHandler("github")).toBe(true);
    expect(providerHasWebhookHandler("gitlab")).toBe(true);
    expect(providerHasWebhookHandler("redmine")).toBe(true);
    expect(providerHasWebhookHandler("gerrit")).toBe(false);
  });

  it("aggregates supported events across a provider's handlers", () => {
    const gitlab = getSupportedEventsForProvider("gitlab");
    expect(gitlab).toContain("issue");
    expect(gitlab).toContain("merge_request");
    expect(gitlab).toContain("note");
    expect(getSupportedEventsForProvider("unknown")).toEqual([]);
  });
});
