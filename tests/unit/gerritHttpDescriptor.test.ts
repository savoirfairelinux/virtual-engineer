/**
 * Tests for the Gerrit plugin descriptor — authMode, HTTP config validation,
 * and parseGerritConfig for both SSH and HTTP modes.
 */

import { describe, it, expect } from "vitest";
import { gerritConfigSchema, parseGerritConfig } from "../../src/plugins/descriptors/gerrit.js";
import type { Integration } from "../../src/interfaces.js";

function makeIntegration(configJson: unknown): Integration {
  return {
    id: "test-gerrit",
    type: "gerrit",
    name: "Test Gerrit",
    configJson: JSON.stringify(configJson),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("gerritConfigSchema — SSH mode", () => {
  it("accepts valid SSH config and applies defaults", () => {
    const result = gerritConfigSchema.parse({
      sshHost: "gerrit.local",
      sshUser: "ve-bot",
    });
    expect(result.authMode).toBe("ssh");
    expect(result.sshPort).toBe(29418);
    expect(result.gitAuthorName).toBe("Virtual Engineer");
    expect(result.gitAuthorEmail).toBe("ve@virtual-engineer.local");
  });

  it("rejects SSH config without sshHost", () => {
    const result = gerritConfigSchema.safeParse({ sshUser: "ve-bot" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("sshHost"))).toBe(true);
    }
  });

  it("rejects SSH config without sshUser", () => {
    const result = gerritConfigSchema.safeParse({ sshHost: "gerrit.local" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("sshUser"))).toBe(true);
    }
  });

  it("accepts custom sshPort", () => {
    const result = gerritConfigSchema.parse({
      sshHost: "gerrit.local",
      sshUser: "ve-bot",
      sshPort: 2222,
    });
    expect(result.sshPort).toBe(2222);
  });
});

describe("gerritConfigSchema — HTTP mode", () => {
  it("accepts valid HTTP config", () => {
    const result = gerritConfigSchema.parse({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpUsername: "ve-bot",
      httpToken: "secret-token",
    });
    expect(result.authMode).toBe("http");
    expect(result.httpBaseUrl).toBe("https://gerrit.example.com");
    expect(result.httpUsername).toBe("ve-bot");
    expect(result.httpToken).toBe("secret-token");
  });

  it("rejects HTTP mode without httpBaseUrl", () => {
    const result = gerritConfigSchema.safeParse({
      authMode: "http",
      httpUsername: "ve-bot",
      httpToken: "secret-token",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("httpBaseUrl"))).toBe(true);
    }
  });

  it("rejects HTTP mode without httpUsername", () => {
    const result = gerritConfigSchema.safeParse({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpToken: "secret-token",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("httpUsername"))).toBe(true);
    }
  });

  it("rejects HTTP mode without httpToken", () => {
    const result = gerritConfigSchema.safeParse({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpUsername: "ve-bot",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("httpToken"))).toBe(true);
    }
  });

  it("applies gitAuthorName/Email defaults in HTTP mode", () => {
    const result = gerritConfigSchema.parse({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpUsername: "ve-bot",
      httpToken: "secret-token",
    });
    expect(result.gitAuthorName).toBe("Virtual Engineer");
    expect(result.gitAuthorEmail).toBe("ve@virtual-engineer.local");
  });
});

describe("parseGerritConfig", () => {
  it("returns null for invalid JSON", () => {
    const integration: Integration = {
      id: "bad",
      type: "gerrit",
      name: "Bad",
      configJson: "not-json",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(parseGerritConfig(integration)).toBeNull();
  });

  it("returns null when SSH fields missing in SSH mode", () => {
    expect(parseGerritConfig(makeIntegration({ sshHost: "gerrit.local" }))).toBeNull();
  });

  it("parses valid SSH config and applies defaults", () => {
    const cfg = parseGerritConfig(makeIntegration({ sshHost: "gerrit.local", sshUser: "ve-bot" }));
    expect(cfg).not.toBeNull();
    expect(cfg!.authMode).toBe("ssh");
    expect(cfg!.sshPort).toBe(29418);
    expect(cfg!.sshHost).toBe("gerrit.local");
    expect(cfg!.sshUser).toBe("ve-bot");
  });

  it("parses valid HTTP config", () => {
    const cfg = parseGerritConfig(makeIntegration({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpUsername: "ve-bot",
      httpToken: "secret",
    }));
    expect(cfg).not.toBeNull();
    expect(cfg!.authMode).toBe("http");
    expect(cfg!.httpBaseUrl).toBe("https://gerrit.example.com");
  });

  it("strips empty string httpToken before parsing so default handling works", () => {
    // If token is empty string, parseGerritConfig strips it so Zod refine will
    // catch the missing-token error and return null
    const cfg = parseGerritConfig(makeIntegration({
      authMode: "http",
      httpBaseUrl: "https://gerrit.example.com",
      httpUsername: "ve-bot",
      httpToken: "",
    }));
    expect(cfg).toBeNull();
  });
});
