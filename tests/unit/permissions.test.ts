import { describe, it, expect } from "vitest";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  isKnownPermission,
  isScopeablePermission,
  resourceTypeOf,
} from "../../src/admin/authorization/permissions.js";

describe("permissions catalog", () => {
  it("every catalog value is a <resourceType>.<action> string", () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(perm).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it("recognises known permissions and rejects unknown ones", () => {
    expect(isKnownPermission(PERMISSIONS.PROJECT_READ)).toBe(true);
    expect(isKnownPermission("project.read")).toBe(true);
    expect(isKnownPermission("project.nonsense")).toBe(false);
    expect(isKnownPermission("")).toBe(false);
  });

  it("resourceTypeOf extracts the prefix before the dot", () => {
    expect(resourceTypeOf("project.read")).toBe("project");
    expect(resourceTypeOf("integration.write")).toBe("integration");
    expect(resourceTypeOf("malformed")).toBeNull();
    expect(resourceTypeOf(".read")).toBeNull();
  });

  it("marks project/task as scopeable and shared/global resources as not", () => {
    expect(isScopeablePermission(PERMISSIONS.PROJECT_READ)).toBe(true);
    expect(isScopeablePermission(PERMISSIONS.TASK_READ)).toBe(true);
    // Integrations, agents and prompts are shared library resources → global only.
    expect(isScopeablePermission(PERMISSIONS.INTEGRATION_WRITE)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.AGENT_READ)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.PROMPT_WRITE)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.USER_MANAGE)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.AUDIT_READ)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.POLICY_MANAGE)).toBe(false);
    expect(isScopeablePermission(PERMISSIONS.OVERVIEW_READ)).toBe(false);
  });

  it("catalog has no duplicate permission strings", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});
