import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("waits for a TCP port without requiring access to the server process", async () => {
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
        'if wait_for_tcp_port 127.0.0.1 "$1" 5; then printf yes; else printf no; fi',
        [port],
      )).toBe("yes");
    } finally {
      server.kill();
    }
  });

  it("recognizes a kubectl process owned by the current workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const kubectlPath = join(dir, "kubectl");
    copyFileSync("/bin/sleep", kubectlPath);
    chmodSync(kubectlPath, 0o755);
    const process = spawn(kubectlPath, ["10"], { cwd: dir, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      process.once("spawn", resolve);
      process.once("error", reject);
    });

    try {
      expect(runHelper(
        'if is_managed_openshell_port_forward "$1" "$2"; then printf yes; else printf no; fi',
        [String(process.pid), dir],
      )).toBe("yes");
      expect(runHelper(
        'if is_managed_openshell_port_forward "$1" "$2"; then printf yes; else printf no; fi',
        [String(process.pid), `${dir}-other`],
      )).toBe("no");
    } finally {
      process.kill();
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

  it.each([
    { input: "", expected: "docker" },
    { input: "docker", expected: "docker" },
    { input: "kubernetes", expected: "kubernetes" },
  ])("normalizes OpenShell compute driver $input to $expected", ({ input, expected }) => {
    expect(runHelper('normalize_openshell_compute_driver "$1"', [input])).toBe(expected);
  });

  it("rejects unsupported OpenShell compute drivers", () => {
    expect(() => runHelper('normalize_openshell_compute_driver "$1"', ["podman"])).toThrow();
  });

  it("writes an authenticated Docker-driver gateway configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const configPath = join(dir, "gateway.toml");
    const supervisorImage = "ghcr.io/nvidia/openshell/supervisor:0.0.83@sha256:9f5c14d914731f84ce38e61cba4cec425a59f0aad4be0c0906342c68ba65a86f";

    runHelper(
      'write_docker_gateway_config "$1" "$2" "$3" "$4" "$5" "$6"',
      [
        configPath,
        "https://keycloak.example/realms/openshell",
        "virtual-engineer-workspace:latest",
        supervisorImage,
        "30808",
        "/var/lib/openshell/pki/jwt",
      ],
    );

    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("[openshell]\nversion = 1");
    expect(config).toContain('bind_address = "0.0.0.0:30808"');
    expect(config).toContain('health_bind_address = "0.0.0.0:30809"');
    expect(config).toContain('compute_drivers = ["docker"]');
    expect(config).toContain("disable_tls = true");
    expect(config).toContain("[openshell.gateway.auth]");
    expect(config).toContain("allow_unauthenticated_users = false");
    expect(config).toContain("[openshell.gateway.oidc]");
    expect(config).toContain('issuer = "https://keycloak.example/realms/openshell"');
    expect(config).toContain('audience = "openshell-cli"');
    expect(config).toContain('roles_claim = "realm_access.roles"');
    expect(config).toContain('admin_role = "openshell-admin"');
    expect(config).toContain('user_role = "openshell-user"');
    expect(config).toContain('scopes_claim = ""');
    expect(config).toContain("[openshell.gateway.gateway_jwt]");
    expect(config).toContain('signing_key_path = "/var/lib/openshell/pki/jwt/signing.pem"');
    expect(config).toContain('public_key_path = "/var/lib/openshell/pki/jwt/public.pem"');
    expect(config).toContain('kid_path = "/var/lib/openshell/pki/jwt/kid"');
    expect(config).toContain('gateway_id = "virtual-engineer"');
    expect(config).toContain("ttl_secs = 7200");
    expect(config).toContain("[openshell.drivers.docker]");
    expect(config).not.toContain("socket_path");
    expect(config).toContain('default_image = "virtual-engineer-workspace:latest"');
    expect(config).toContain(`supervisor_image = "${supervisorImage}"`);
    expect(config).toContain('image_pull_policy = "IfNotPresent"');
    expect(config).toContain('sandbox_namespace = "virtual-engineer"');
    expect(config).toContain('grpc_endpoint = "http://host.openshell.internal:30808"');
    expect(config).toContain('network_name = "openshell-docker"');
    expect(config).toContain("enable_bind_mounts = false");
    expect(config).toContain("sandbox_pids_limit = 2048");
  });
});

describe("OpenShell deployment contract", () => {
  it("excludes runtime data from Docker build contexts", () => {
    const dockerignore = readFileSync(".dockerignore", "utf8");

    expect(dockerignore).toMatch(/^data\/$/m);
    expect(dockerignore).toMatch(/^node_modules\/$/m);
    expect(dockerignore).toMatch(/^dist\/$/m);
  });

  it("uses the OpenShell Docker driver by default and keeps Kubernetes opt-in", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain('OPENSHELL_COMPUTE_DRIVER=$(normalize_openshell_compute_driver');
    expect(script).toContain('if [[ "$OPENSHELL_COMPUTE_DRIVER" == "kubernetes" ]]');
    expect(script).toContain('write_docker_gateway_config');
    expect(script).toContain('OPENSHELL_GATEWAY_IMAGE="ghcr.io/nvidia/openshell/gateway:0.0.83@sha256:');
    expect(script).toContain('OPENSHELL_SUPERVISOR_IMAGE="ghcr.io/nvidia/openshell/supervisor:0.0.83@sha256:');
    expect(script).toContain('--name ve-openshell-gateway');
    expect(script).toContain('--security-opt label=disable');
    expect(script).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(script).toContain('OPENSHELL_GATEWAY_PKI_DIR=');
    expect(script).toContain('generate-certs --output-dir "$OPENSHELL_GATEWAY_PKI_DIR"');
    expect(script.match(/stop_managed_openshell_port_forward/g)).toHaveLength(2);
    expect(script).toContain('OPENSHELL_GATEWAY_JWT_HASH=$(docker run --rm');
    expect(script).not.toContain('sha256sum "${OPENSHELL_GATEWAY_PKI_DIR}/jwt/public.pem"');
    expect(script).toContain("docker network inspect openshell-docker");
    expect(script).toContain("OPENSHELL_DOCKER_BRIDGE_IP=");
    expect(script).toContain('-p "${OPENSHELL_DOCKER_BRIDGE_IP}:${OPENSHELL_GW_LOCAL_PORT}:${OPENSHELL_GW_LOCAL_PORT}"');
  });

  it("provides a Docker-local Keycloak realm for the default driver", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const realm = readFileSync("deploy/docker/keycloak-realm.json", "utf8");

    expect(script).toContain('--name ve-local-keycloak');
    expect(script).toContain('KC_HTTP_PORT=18081');
    expect(script).toContain('deploy/docker/keycloak-realm.json');
    expect(realm).toContain('"clientId": "openshell-ci"');
    expect(realm).toContain('"serviceAccountsEnabled": true');
    expect(realm).toContain('"openshell-admin"');
    expect(realm).toContain('"openshell-user"');
  });

  it("builds the agent image with the account required by OpenShell", () => {
    const dockerfile = readFileSync("Dockerfile.agent", "utf8");

    expect(dockerfile).toContain("groupadd --system sandbox");
    expect(dockerfile).toContain("useradd --system --gid sandbox");
    expect(dockerfile).toContain("--home-dir /sandbox");
  });

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

    expect(script).toContain('OPENSHELL_VERSION="v0.0.83"');
    expect(script).not.toContain("--openshell-version");
    expect(script).not.toContain("${OPENSHELL_VERSION:-");
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

  it("allows OpenShell sandbox capabilities while auditing restricted violations", () => {
    const rbacManifest = readFileSync("deploy/k8s/15-rbac-openshell.yaml", "utf8");

    expect(rbacManifest).toContain("pod-security.kubernetes.io/enforce: privileged");
    expect(rbacManifest).toContain("pod-security.kubernetes.io/audit: restricted");
    expect(rbacManifest).toContain("pod-security.kubernetes.io/warn: restricted");
    expect(rbacManifest).not.toContain("pod-security.kubernetes.io/enforce: baseline");
  });
});