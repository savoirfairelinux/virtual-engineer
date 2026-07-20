import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateGerritSshKeyPair } from "../../src/plugins/descriptors/gerrit.js";

describe("generateGerritSshKeyPair", () => {
  const originalSecret = process.env["ADMIN_AUTH_SECRET"];

  beforeEach(() => {
    process.env["ADMIN_AUTH_SECRET"] = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env["ADMIN_AUTH_SECRET"];
    else process.env["ADMIN_AUTH_SECRET"] = originalSecret;
  });

  it("embeds the configured sshUser in the public key comment", () => {
    const { sshPublicKey } = generateGerritSshKeyPair(process.env["ADMIN_AUTH_SECRET"], "virtual-reviewer");
    expect(sshPublicKey.endsWith(" virtual-reviewer-gerrit")).toBe(true);
  });

  it("falls back to virtual-engineer-gerrit when no sshUser is provided", () => {
    const { sshPublicKey } = generateGerritSshKeyPair(process.env["ADMIN_AUTH_SECRET"], undefined);
    expect(sshPublicKey.endsWith(" virtual-engineer-gerrit")).toBe(true);
  });

  it("falls back to virtual-engineer-gerrit when sshUser is blank", () => {
    const { sshPublicKey } = generateGerritSshKeyPair(process.env["ADMIN_AUTH_SECRET"], "   ");
    expect(sshPublicKey.endsWith(" virtual-engineer-gerrit")).toBe(true);
  });
});
