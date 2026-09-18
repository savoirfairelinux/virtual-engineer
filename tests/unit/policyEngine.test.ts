import { describe, it, expect } from "vitest";
import type { EffectivePolicyRule, PolicyRule } from "../../src/interfaces.js";
import { oauthAppResourceId, parseOAuthAppResourceId } from "../../src/domain/accessControl.js";
import {
  ALL_RESOURCES,
  accessibleResourceIds,
  buildEffectivePermissions,
  can,
  canAccessResource,
  hasPotentialResourceAccess,
} from "../../src/admin/authorization/policyEngine.js";

let seq = 0;
function rule(permission: string, resourceId: string | null): PolicyRule {
  return {
    id: `rule-${seq++}`,
    policyId: "policy-1",
    permission,
    resourceId,
    createdAt: new Date(),
  };
}

function systemRule(
  permission: string,
  principalId: "registered_users" | "resource_owner" | "project_owners"
): EffectivePolicyRule {
  return {
    ...rule(permission, null),
    principalType: "system",
    principalId,
  };
}

describe("policyEngine — buildEffectivePermissions", () => {
  it("round-trips composite OAuth app resource ids", () => {
    const resourceId = oauthAppResourceId("gitlab", "https://gitlab.example.com/path");
    expect(parseOAuthAppResourceId(resourceId)).toEqual({
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com/path",
    });
    expect(parseOAuthAppResourceId("invalid")).toBeNull();
  });

  it("admin role is a superuser regardless of rules", () => {
    const perms = buildEffectivePermissions("admin", []);
    expect(perms.isSuperuser).toBe(true);
    expect(can(perms, "project.read", "any")).toBe(true);
    expect(can(perms, "user.manage")).toBe(true);
  });

  it("non-admin with no rules is default-deny", () => {
    const perms = buildEffectivePermissions("viewer", []);
    expect(perms.isSuperuser).toBe(false);
    expect(can(perms, "project.read", "p1")).toBe(false);
    expect(can(perms, "overview.read")).toBe(false);
  });

  it("a null-resource rule grants the permission on all resources", () => {
    const perms = buildEffectivePermissions("operator", [rule("project.read", null)]);
    expect(can(perms, "project.read", "p1")).toBe(true);
    expect(can(perms, "project.read", "p2")).toBe(true);
    expect(can(perms, "project.read")).toBe(true); // unscoped check
    expect(accessibleResourceIds(perms, "project.read")).toBe(ALL_RESOURCES);
  });

  it("a scoped rule grants only the named resource", () => {
    const perms = buildEffectivePermissions("operator", [rule("project.read", "p1")]);
    expect(can(perms, "project.read", "p1")).toBe(true);
    expect(can(perms, "project.read", "p2")).toBe(false);
    // A scoped grant does not satisfy an unscoped (global) check.
    expect(can(perms, "project.read")).toBe(false);
    const scope = accessibleResourceIds(perms, "project.read");
    expect(scope).toBeInstanceOf(Set);
    expect([...(scope as Set<string>)]).toEqual(["p1"]);
  });

  it("merges multiple scoped rules into one id set", () => {
    const perms = buildEffectivePermissions("operator", [
      rule("project.read", "p1"),
      rule("project.read", "p2"),
    ]);
    expect(can(perms, "project.read", "p1")).toBe(true);
    expect(can(perms, "project.read", "p2")).toBe(true);
    expect(can(perms, "project.read", "p3")).toBe(false);
  });

  it("a widest (null) rule wins over scoped rules for the same permission", () => {
    const perms = buildEffectivePermissions("operator", [
      rule("project.read", "p1"),
      rule("project.read", null),
    ]);
    expect(accessibleResourceIds(perms, "project.read")).toBe(ALL_RESOURCES);
    expect(can(perms, "project.read", "p99")).toBe(true);
  });

  it("accessibleResourceIds returns null when the permission is not granted", () => {
    const perms = buildEffectivePermissions("operator", [rule("project.read", "p1")]);
    expect(accessibleResourceIds(perms, "integration.read")).toBeNull();
  });

  it("superuser accessibleResourceIds is ALL_RESOURCES", () => {
    const perms = buildEffectivePermissions("admin", []);
    expect(accessibleResourceIds(perms, "integration.read")).toBe(ALL_RESOURCES);
  });

  it("grants resource-owner permissions only to the creating user", () => {
    const perms = buildEffectivePermissions("operator", [
      systemRule("prompt.read", "resource_owner"),
      systemRule("prompt.write", "resource_owner"),
    ]);
    const prompt = { type: "prompt", id: "prompt-1", ownerUserId: "user-1" } as const;

    expect(canAccessResource(perms, "prompt.read", prompt, "user-1")).toBe(true);
    expect(canAccessResource(perms, "prompt.write", prompt, "user-2")).toBe(false);
    expect(hasPotentialResourceAccess(perms, "prompt.read")).toBe(true);
  });

  it("lets registered users read legacy resources without exposing owned resources", () => {
    const perms = buildEffectivePermissions("viewer", [
      systemRule("integration.read", "registered_users"),
    ]);

    expect(canAccessResource(
      perms,
      "integration.read",
      { type: "integration", id: "legacy", ownerUserId: null },
      "user-2"
    )).toBe(true);
    expect(canAccessResource(
      perms,
      "integration.read",
      { type: "integration", id: "private", ownerUserId: "user-1" },
      "user-2"
    )).toBe(false);
  });

  it("fails closed for unresolved task ownership unless access is explicitly scoped", () => {
    const registeredOnly = buildEffectivePermissions("viewer", [
      systemRule("task.read", "registered_users"),
    ]);
    const unresolvedTask = {
      type: "task",
      id: "task-1",
      projectId: "project-1",
      ownerUserId: undefined,
    } as const;

    expect(canAccessResource(registeredOnly, "task.read", unresolvedTask, "user-2")).toBe(false);

    const explicitlyScoped = buildEffectivePermissions("viewer", [
      systemRule("task.read", "registered_users"),
      rule("task.read", "project-1"),
    ]);
    expect(canAccessResource(explicitlyScoped, "task.read", unresolvedTask, "user-2")).toBe(true);
  });

  it("applies Project Owners permissions only inside delegated projects", () => {
    const perms = buildEffectivePermissions("operator", [
      rule("project.owner", "project-1"),
      systemRule("project.write", "project_owners"),
      systemRule("task.operate", "project_owners"),
    ]);

    expect(canAccessResource(
      perms,
      "project.write",
      { type: "project", id: "project-1", ownerUserId: "another-user" },
      "delegate"
    )).toBe(true);
    expect(canAccessResource(
      perms,
      "project.write",
      { type: "project", id: "project-2", ownerUserId: "another-user" },
      "delegate"
    )).toBe(false);
    expect(canAccessResource(
      perms,
      "task.operate",
      { type: "task", id: "task-1", projectId: "project-1", ownerUserId: "another-user" },
      "delegate"
    )).toBe(true);
  });
});
