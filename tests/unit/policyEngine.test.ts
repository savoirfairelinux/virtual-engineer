import { describe, it, expect } from "vitest";
import type { PolicyRule } from "../../src/interfaces.js";
import {
  ALL_RESOURCES,
  accessibleResourceIds,
  buildEffectivePermissions,
  can,
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

describe("policyEngine — buildEffectivePermissions", () => {
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
});
