import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runHelper(script: string, args: string[] = []): string {
  return execFileSync("bash", ["-c", `source scripts/start-lib.sh; ${script}`, "test", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function runDeployHelper(script: string, args: string[] = []): string {
  return execFileSync("bash", ["-c", `source deploy/k8s/deploy-lib.sh; ${script}`, "test", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

describe("start.sh helpers", () => {
  it.each([
    { clusterReady: "true", noNewPrivileges: "true", expected: "yes" },
    { clusterReady: "false", noNewPrivileges: "false", expected: "yes" },
    { clusterReady: "false", noNewPrivileges: "true", expected: "no" },
  ])("privilege preflight permits accessible cluster: $expected", ({ clusterReady, noNewPrivileges, expected }) => {
    const actual = runHelper(
      'if can_prepare_k3s "$1" "$2"; then printf yes; else printf no; fi',
      [clusterReady, noNewPrivileges],
    );
    expect(actual).toBe(expected);
  });

  it.each([
    { dockerId: "sha256:abc123", runtimeId: "sha256:abc123", expected: "yes" },
    { dockerId: "sha256:abc123", runtimeId: "docker-pullable://repo@sha256:abc123", expected: "yes" },
    { dockerId: "sha256:abc123", runtimeId: "sha256:def456", expected: "no" },
    { dockerId: "", runtimeId: "sha256:abc123", expected: "no" },
  ])("compares exact runtime image identity: $expected", ({ dockerId, runtimeId, expected }) => {
    const actual = runHelper(
      'if image_ids_match "$1" "$2"; then printf yes; else printf no; fi',
      [dockerId, runtimeId],
    );
    expect(actual).toBe(expected);
  });

  it("waits for a live process to open the expected TCP port", async () => {
    const server = spawn("node", [
      "-e",
      "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>{},10000)",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        server.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
        server.once("error", reject);
      });
      expect(runHelper(
        'if wait_for_tcp_listener "$1" 127.0.0.1 "$2" 5; then printf yes; else printf no; fi',
        [String(server.pid), port],
      )).toBe("yes");
    } finally {
      server.kill();
    }
  });

  it.each([
    { issuer: "", secret: "", expected: "local" },
    { issuer: "https://id.example/realms/openshell", secret: "client-secret", expected: "external" },
  ])("selects $expected OIDC mode", ({ issuer, secret, expected }) => {
    expect(runHelper('oidc_mode "$1" "$2"', [issuer, secret])).toBe(expected);
  });

  it.each([
    { issuer: "https://id.example/realms/openshell", secret: "" },
    { issuer: "", secret: "client-secret" },
  ])("rejects partial external OIDC configuration", ({ issuer, secret }) => {
    expect(() => runHelper('oidc_mode "$1" "$2"', [issuer, secret])).toThrow();
  });

  it("creates a persistent owner-only local OIDC secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const secretFile = join(dir, "nested", "client-secret");

    const first = runHelper('load_or_create_secret "$1"', [secretFile]);
    const second = runHelper('load_or_create_secret "$1"', [secretFile]);
    const mode = runHelper('stat -c "%a" "$1"', [secretFile]);
    const bytes = runHelper('wc -c < "$1"', [secretFile]);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(mode).toBe("600");
    expect(bytes.trim()).toBe("64");
  });

  it("loads startup variables from a dotenv file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, [
      "OPENSHELL_OIDC_ISSUER=https://keycloak.example/realms/openshell",
      "OPENSHELL_OIDC_CLIENT_SECRET='literal secret value'",
      "",
    ].join("\n"));

    const actual = runHelper(
      'unset OPENSHELL_OIDC_ISSUER OPENSHELL_OIDC_CLIENT_SECRET; load_dotenv "$1"; printf "%s|%s" "$OPENSHELL_OIDC_ISSUER" "$OPENSHELL_OIDC_CLIENT_SECRET"',
      [envFile],
    );

    expect(actual).toBe("https://keycloak.example/realms/openshell|literal secret value");
  });

  it("does not override variables already exported by the caller", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "OPENSHELL_OIDC_ISSUER=https://dotenv.example/realms/openshell\n");

    const actual = runHelper(
      'export OPENSHELL_OIDC_ISSUER=https://shell.example/realms/openshell; load_dotenv "$1"; printf "%s" "$OPENSHELL_OIDC_ISSUER"',
      [envFile],
    );

    expect(actual).toBe("https://shell.example/realms/openshell");
  });

  it("never evaluates dotenv values as shell code", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const marker = join(dir, "executed");
    writeFileSync(envFile, `OPENSHELL_OIDC_CLIENT_SECRET=$(touch ${marker})\n`);

    const actual = runHelper(
      'unset OPENSHELL_OIDC_CLIENT_SECRET; load_dotenv "$1"; printf "%s" "$OPENSHELL_OIDC_CLIENT_SECRET"',
      [envFile],
    );

    expect(actual).toBe(`$(touch ${marker})`);
    expect(() => readFileSync(marker)).toThrow();
  });

  it("hashes env contents and effective docker arguments deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "ADMIN_API_PORT=3100\n");

    const first = runHelper('run_config_hash "$1" "${@:2}"', [envFile, "--network", "host"]);
    const unchanged = runHelper('run_config_hash "$1" "${@:2}"', [envFile, "--network", "host"]);
    writeFileSync(envFile, "ADMIN_API_PORT=3200\n");
    const envChanged = runHelper('run_config_hash "$1" "${@:2}"', [envFile, "--network", "host"]);
    const argsChanged = runHelper('run_config_hash "$1" "${@:2}"', [envFile, "--network", "bridge"]);

    expect(unchanged).toBe(first);
    expect(envChanged).not.toBe(first);
    expect(argsChanged).not.toBe(envChanged);
  });

  it("distinguishes a missing env file from an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const missing = runHelper('run_config_hash "$1"', [envFile]);
    writeFileSync(envFile, "");
    const empty = runHelper('run_config_hash "$1"', [envFile]);

    expect(missing).not.toBe(empty);
  });

  it.each([
    { name: "unchanged", expected: "yes", running: "true", runningImage: "sha256:new", latestImage: "sha256:new", marker: "cfg", current: "cfg" },
    { name: "changed env marker", expected: "no", running: "true", runningImage: "sha256:new", latestImage: "sha256:new", marker: "old", current: "cfg" },
    { name: "missing image", expected: "no", running: "true", runningImage: "", latestImage: "", marker: "cfg", current: "cfg" },
    { name: "stopped container", expected: "no", running: "false", runningImage: "sha256:new", latestImage: "sha256:new", marker: "cfg", current: "cfg" },
  ])("container reuse decision: $name", ({ expected, running, runningImage, latestImage, marker, current }) => {
    const actual = runHelper(
      'if should_reuse_container "$1" "$2" "$3" "$4" "$5"; then printf yes; else printf no; fi',
      [running, runningImage, latestImage, marker, current],
    );
    expect(actual).toBe(expected);
  });
});

describe("OpenShell deployment contract", () => {
  it("provides an authenticated local Keycloak fallback", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const manifest = readFileSync("deploy/k8s/17-keycloak-local.yaml", "utf8");

    expect(script).toContain('OIDC_MODE=$(oidc_mode "$OPENSHELL_OIDC_ISSUER" "${OPENSHELL_OIDC_CLIENT_SECRET:-}")');
    expect(script).toContain("deploy/k8s/17-keycloak-local.yaml");
    expect(script).toContain("export OPENSHELL_OIDC_CLIENT_SECRET");
    expect(script).toContain('--from-file="OPENSHELL_OIDC_CLIENT_SECRET=${LOCAL_OIDC_DIR}/client-secret"');
    expect(script).not.toContain('--from-literal="OPENSHELL_OIDC_CLIENT_SECRET=');
    expect(script).toContain("--add-host");
    expect(manifest).toContain("quay.io/keycloak/keycloak@sha256:");
    expect(manifest).not.toContain("allowUnauthenticatedUsers: true");
    expect(manifest).toContain('"serviceAccountsEnabled": true');
    expect(manifest).toContain('"openshell-admin"');
    expect(manifest).toContain('"openshell-user"');
    expect(manifest).not.toContain("REPLACE_ME");
  });

  it("pins OpenShell 0.0.83 and the verified Helm chart digest", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const dockerfile = readFileSync("Dockerfile.orchestrator", "utf8");
    const values = readFileSync("deploy/k8s/openshell-gateway-values.yaml", "utf8");

    expect(script).toContain('OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.83}"');
    expect(script).toContain("sha256:583bcd4eecf7a255c6201ba3b571b5207ee0f643630dfa4835e981e62c754cc7");
    expect(script).toContain('oci://ghcr.io/nvidia/openshell/helm-chart@${OPENSHELL_CHART_DIGEST}');
    expect(dockerfile).toContain("ARG OPENSHELL_VERSION=v0.0.83");
    expect(values).toContain("0.0.83@sha256:80e898dc9ad46e4f40b8b0e8648658d0e51b83f1c2071cf4983ac6d52b9c95d6");
    expect(values).toContain("0.0.83@sha256:9f5c14d914731f84ce38e61cba4cec425a59f0aad4be0c0906342c68ba65a86f");
  });

  it("fails closed with named-profile Keycloak OIDC", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const values = readFileSync("deploy/k8s/openshell-gateway-values.yaml", "utf8");

    expect(values).toContain("allowUnauthenticatedUsers: false");
    expect(values).toContain("rolesClaim: realm_access.roles");
    expect(values).toContain("adminRole: openshell-admin");
    expect(values).toContain("userRole: openshell-user");
    expect(values).not.toContain("OPENSHELL_OIDC_CLIENT_SECRET");
    expect(script).toContain('OPENSHELL_GATEWAY_NAME="${OPENSHELL_GATEWAY_NAME:-virtual-engineer}"');
    expect(script).toContain("--oidc-issuer");
    expect(script).toContain("--oidc-client-id");
    expect(script).toContain("--oidc-audience");
    expect(script).toContain('-e "OPENSHELL_GATEWAY=${OPENSHELL_GATEWAY_NAME}"');
  });

  it("requires immutable GHCR image references for production", () => {
    const digest = "a".repeat(64);
    expect(runDeployHelper(
      'if require_ghcr_digest_ref "$1"; then printf yes; else printf no; fi',
      [`ghcr.io/example/virtual-engineer@sha256:${digest}`],
    )).toBe("yes");
    expect(runDeployHelper(
      'if require_ghcr_digest_ref "$1"; then printf yes; else printf no; fi',
      ["ghcr.io/example/virtual-engineer:latest"],
    )).toBe("no");
    expect(runDeployHelper(
      'if require_ghcr_digest_ref "$1"; then printf yes; else printf no; fi',
      [`registry.example.com/virtual-engineer@sha256:${digest}`],
    )).toBe("no");
  });

  it("mirrors the GHCR pull secret and pins both VE workloads", () => {
    const deployScript = readFileSync("deploy/k8s/deploy.sh", "utf8");

    expect(deployScript).toContain('for namespace in virtual-engineer ve-agents');
    expect(deployScript).toContain('server.sandboxImage=${VE_AGENT_IMAGE}');
    expect(deployScript).toContain('server.sandboxImagePullSecrets[0].name=${IMAGE_PULL_SECRET}');
    expect(deployScript).toContain('imagePullSecrets[0].name=${IMAGE_PULL_SECRET}');
    expect(deployScript).toContain('kubectl create secret generic openshell-client-tls');
    expect(deployScript).toContain('--namespace ve-agents');
    expect(deployScript).toContain('kubectl delete rolebinding ve-openshell-gateway role ve-agent-pod-manager');
    expect(deployScript).toContain('"*=${VE_ORCHESTRATOR_IMAGE}"');
    expect(deployScript).toContain('kubectl rollout restart deployment/virtual-engineer-orchestrator');
    expect(deployScript).toContain('kubectl rollout status deployment/virtual-engineer-orchestrator');
    expect(deployScript).not.toContain("REPLACE_ME");
  });
});