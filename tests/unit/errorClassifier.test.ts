import { describe, it, expect } from "vitest";
import { isInfrastructureError } from "../../src/utils/errorClassifier.js";

describe("isInfrastructureError", () => {
  it("flags Gerrit SSH connection-establishment failures", () => {
    expect(isInfrastructureError(new Error("ssh: connect to host gerrit.example.com port 29418: Connection refused"))).toBe(true);
    expect(isInfrastructureError(new Error("Permission denied (publickey)."))).toBe(true);
    expect(isInfrastructureError(new Error("Host key verification failed."))).toBe(true);
    expect(isInfrastructureError(new Error("Could not resolve hostname gerrit.example.com"))).toBe(true);
    expect(isInfrastructureError(new Error("SSH review timed out after 30000ms: ssh -p 29418 ..."))).toBe(true);
  });

  it("flags Node socket / DNS error codes", () => {
    expect(isInfrastructureError(new Error("connect ECONNREFUSED 10.0.0.1:29418"))).toBe(true);
    expect(isInfrastructureError(new Error("getaddrinfo ENOTFOUND gerrit"))).toBe(true);
    expect(isInfrastructureError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not flag genuine task failures", () => {
    expect(isInfrastructureError(new Error("Agent produced no changes after cycle 2"))).toBe(false);
    expect(isInfrastructureError(new Error("merge conflict in src/index.ts"))).toBe(false);
    expect(isInfrastructureError(new Error("Ticket close failed (change is merged): validation error"))).toBe(false);
  });

  it("handles non-Error inputs", () => {
    expect(isInfrastructureError("ECONNREFUSED")).toBe(true);
    expect(isInfrastructureError(undefined)).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
  });
});
