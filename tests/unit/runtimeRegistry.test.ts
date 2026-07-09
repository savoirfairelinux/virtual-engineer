import { describe, it, expect, vi } from "vitest";
import type { WorkspaceRunner } from "../../src/interfaces.js";
import {
  DEFAULT_RUNTIME_ID,
  RUNTIME_IDS,
  isRuntimeId,
  normalizeRuntimeId,
  resolveRuntimeId,
} from "../../src/runtime/runtimeProfile.js";
import { RuntimeRegistry } from "../../src/runtime/runtimeRegistry.js";

function fakeRunner(): WorkspaceRunner {
  return {
    createWorkspace: vi.fn(),
    cloneRepo: vi.fn(),
    runAgent: vi.fn(),
    destroyWorkspace: vi.fn(),
  } as unknown as WorkspaceRunner;
}

describe("runtimeProfile", () => {
  it("exposes docker as the built-in default", () => {
    expect(DEFAULT_RUNTIME_ID).toBe("docker");
    expect(RUNTIME_IDS).toContain("docker");
    expect(RUNTIME_IDS).toContain("openshell");
  });

  it("isRuntimeId accepts known ids and rejects others", () => {
    expect(isRuntimeId("docker")).toBe(true);
    expect(isRuntimeId("openshell")).toBe(true);
    expect(isRuntimeId("podman")).toBe(false);
    expect(isRuntimeId(42)).toBe(false);
    expect(isRuntimeId(undefined)).toBe(false);
  });

  it("normalizeRuntimeId trims, validates, and rejects empties", () => {
    expect(normalizeRuntimeId(" openshell ")).toBe("openshell");
    expect(normalizeRuntimeId("docker")).toBe("docker");
    expect(normalizeRuntimeId("")).toBeUndefined();
    expect(normalizeRuntimeId("   ")).toBeUndefined();
    expect(normalizeRuntimeId(null)).toBeUndefined();
    expect(normalizeRuntimeId(undefined)).toBeUndefined();
    expect(normalizeRuntimeId("nope")).toBeUndefined();
  });

  it("resolveRuntimeId honours project > agent > default > built-in", () => {
    expect(resolveRuntimeId({ project: "openshell", agent: "docker", default: "docker" })).toBe("openshell");
    expect(resolveRuntimeId({ project: null, agent: "openshell", default: "docker" })).toBe("openshell");
    expect(resolveRuntimeId({ project: null, agent: null, default: "openshell" })).toBe("openshell");
    expect(resolveRuntimeId({})).toBe("docker");
  });
});

describe("RuntimeRegistry", () => {
  it("registers and gets runners by id", () => {
    const docker = fakeRunner();
    const registry = new RuntimeRegistry();
    registry.register("docker", docker);
    expect(registry.has("docker")).toBe(true);
    expect(registry.get("docker")).toBe(docker);
    expect(registry.list()).toEqual(["docker"]);
  });

  it("throws when getting an unregistered runtime", () => {
    const registry = new RuntimeRegistry();
    expect(() => registry.get("openshell")).toThrow(/no workspace runner registered/i);
  });

  it("resolve returns the runner for the selected runtime", () => {
    const docker = fakeRunner();
    const openshell = fakeRunner();
    const registry = new RuntimeRegistry().register("docker", docker).register("openshell", openshell);
    expect(registry.resolve({ project: "openshell" })).toBe(openshell);
    expect(registry.resolve({ agent: "docker" })).toBe(docker);
  });

  it("resolve falls back to the default runner when the selected runtime is unregistered", () => {
    const docker = fakeRunner();
    const registry = new RuntimeRegistry().register("docker", docker);
    // openshell is selected but not registered → degrade to default (docker)
    expect(registry.resolve({ project: "openshell" })).toBe(docker);
  });

  it("uses the registry default when no selection tier is set", () => {
    const docker = fakeRunner();
    const openshell = fakeRunner();
    const registry = new RuntimeRegistry("openshell")
      .register("docker", docker)
      .register("openshell", openshell);
    expect(registry.getDefaultId()).toBe("openshell");
    expect(registry.resolve()).toBe(openshell);
  });

  it("setDefault requires a registered runner", () => {
    const docker = fakeRunner();
    const registry = new RuntimeRegistry().register("docker", docker);
    expect(() => registry.setDefault("openshell")).toThrow(/unregistered runtime/i);
    registry.register("openshell", fakeRunner());
    registry.setDefault("openshell");
    expect(registry.getDefaultId()).toBe("openshell");
  });
});
