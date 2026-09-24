import { describe, expect, it } from "vitest";
import {
  formatConfigHash,
  parseConfigHash,
  type ConfigRoute,
} from "../../../src/admin/ui/views/ConfigView/configRouting.js";

describe("Configuration routing", () => {
  it.each<[string, ConfigRoute]>([
    ["#config/prompts/system_review/copy", { section: "prompts", mode: "copy", id: "system_review" }],
    ["#config/integrations", { section: "integrations", mode: "list" }],
    ["#config/backups", { section: "backups", mode: "list" }],
    ["#config/audit/export", { section: "audit", mode: "export" }],
    ["#config/integrations/new", { section: "integrations", mode: "create" }],
    ["#config/integrations/github%20primary", {
      section: "integrations",
      mode: "detail",
      id: "github primary",
    }],
    ["#config/integrations/github%20primary/edit", {
      section: "integrations",
      mode: "edit",
      id: "github primary",
    }],
    ["#config/projects/project-1/statistics", {
      section: "projects",
      mode: "statistics",
      id: "project-1",
    }],
    ["#config/users/user-1/password", {
      section: "users",
      mode: "password",
      id: "user-1",
    }],
    ["#config/oauth/gitlab/https%3A%2F%2Fgitlab.example.com%3A8443%2Fgroup", {
      section: "oauth",
      mode: "detail",
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com:8443/group",
    }],
  ])("parses %s", (hash, route) => {
    expect(parseConfigHash(hash)).toEqual(route);
  });

  it.each<ConfigRoute>([
    { section: "prompts", mode: "copy", id: "prompt/with spaces" },
    { section: "projects", mode: "list" },
    { section: "backups", mode: "list" },
    { section: "audit", mode: "export" },
    { section: "projects", mode: "create" },
    { section: "projects", mode: "detail", id: "project/with spaces" },
    { section: "projects", mode: "edit", id: "project/with spaces" },
    { section: "projects", mode: "statistics", id: "project/with spaces" },
    { section: "users", mode: "password", id: "user/équipe" },
    {
      section: "oauth",
      mode: "detail",
      provider: "gitlab cloud",
      baseUrl: "https://gitlab.example.com:8443/group/a",
    },
  ])("round-trips $section/$mode", (route) => {
    expect(parseConfigHash(formatConfigHash(route))).toEqual(route);
  });

  it.each([
    "#config/not-a-section",
    "#config/overview/new",
    "#config/integrations/missing/edit/extra",
    "#config/oauth/gitlab",
    "#config/oauth/gitlab/not%ZZencoded",
    "#tasks/task-1",
  ])("falls back to the overview for invalid route %s", (hash) => {
    expect(parseConfigHash(hash)).toEqual({ section: "overview", mode: "list" });
  });
});