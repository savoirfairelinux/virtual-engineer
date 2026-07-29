import { describe, expect, it } from "vitest";
import {
  formatConfigHash,
  parseConfigHash,
  type ConfigRoute,
} from "../../../src/admin/ui/views/ConfigView/configRouting.js";

describe("Configuration routing", () => {
  it.each<[string, ConfigRoute]>([
    ["#config/integrations", { section: "integrations", mode: "list" }],
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
    { section: "projects", mode: "list" },
    { section: "projects", mode: "create" },
    { section: "projects", mode: "detail", id: "project/with spaces" },
    { section: "projects", mode: "edit", id: "project/with spaces" },
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