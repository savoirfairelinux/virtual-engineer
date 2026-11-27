import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runLib(script: string, args: string[] = []): string {
  return execFileSync(
    "bash",
    ["-c", `source scripts/start-lib.sh; source scripts/update-lib.sh; ${script}`, "test", ...args],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

describe("update.sh helpers", () => {
  it("replaces or appends one dotenv key and keeps every other line", () => {
    const dir = tempDir("ve-update-env-");
    const env = join(dir, ".env");
    writeFileSync(env, "# comment\nA=1\nexport VE_IMAGE_TAG=0.1.0\nB='two words'\n");
    chmodSync(env, 0o600);

    runLib('set_env_value "$1" VE_IMAGE_TAG 0.4.0', [env]);
    runLib('set_env_value "$1" NEW_KEY value', [env]);

    expect(readFileSync(env, "utf8")).toBe("# comment\nA=1\nVE_IMAGE_TAG=0.4.0\nB='two words'\nNEW_KEY=value\n");
    expect(execFileSync("stat", ["-c", "%a", env], { encoding: "utf8" }).trim()).toBe("600");
  });

  it.each(["0.4.0;id", "$(id)", "a b"])("refuses to write an unsafe dotenv value: %s", (value) => {
    const env = join(tempDir("ve-update-env-"), ".env");
    writeFileSync(env, "A=1\n");
    expect(() => runLib('set_env_value "$1" VE_IMAGE_TAG "$2"', [env, value])).toThrow();
    expect(readFileSync(env, "utf8")).toBe("A=1\n");
  });

  it("reads only a valid version from an update request", () => {
    const dir = tempDir("ve-update-request-");
    const request = join(dir, "update.request");
    writeFileSync(request, "requested_by=admin\nversion=v0.4.0\n");
    expect(runLib('read_update_request "$1"', [request])).toBe("0.4.0");
    writeFileSync(request, "version=0.4.0; touch /tmp/pwned\n");
    expect(() => runLib('read_update_request "$1" 2>/dev/null', [request])).toThrow();
  });

  it("writes a single-line status file the orchestrator can parse", () => {
    const status = join(tempDir("ve-update-status-"), "update.status");
    runLib('write_update_status "$1" failed 0.3.0 0.4.0 "$2"', [status, "line one\nline two"]);
    const text = readFileSync(status, "utf8");
    expect(text).toMatch(/^state=failed\nfrom=0\.3\.0\nto=0\.4\.0\nmessage=line one line two\nupdated_at=\d+\n$/);
  });

  it("extracts the tag of the latest GitHub release", () => {
    const json = '{"url":"x","tag_name": "v0.4.0","name":"v0.4.0","body":"\\"tag_name\\": \\"v9.9.9\\""}';
    expect(execFileSync("bash", ["-c", "source scripts/update-lib.sh; parse_release_tag"], { input: json, encoding: "utf8" }).trim())
      .toBe("v0.4.0");
  });

  it.each([
    ["0.3.0", "0.4.0", "yes"],
    ["0.10.0", "0.9.9", "no"],
    ["1.0.0", "1.0.0", "no"],
    ["0.9.10", "0.10.0", "yes"],
  ])("compares release versions numerically: %s < %s", (left, right, expected) => {
    expect(runLib('if version_lt "$1" "$2"; then printf yes; else printf no; fi', [left, right])).toBe(expected);
  });

  it.each([
    ["", "", "http://127.0.0.1:3100/health"],
    ["0.0.0.0", "8080", "http://127.0.0.1:8080/health"],
    ["10.0.0.5", "3100", "http://10.0.0.5:3100/health"],
    ["::", "3100", "http://[::1]:3100/health"],
    ["fd00::5", "3100", "http://[fd00::5]:3100/health"],
  ])("probes health for ADMIN_API_HOST=%s port=%s", (host, port, expected) => {
    expect(runLib('health_url "$1" "$2"', [host, port])).toBe(expected);
  });

  it.each([
    ["virtual-engineer:latest", "virtual-engineer:ve-rollback"],
    ["virtual-engineer-workspace-claude:latest", "virtual-engineer-workspace-claude:ve-rollback"],
    ["registry.local:5000/ve/workspace", "registry.local:5000/ve/workspace:ve-rollback"],
  ])("names the rollback tag of %s", (image, expected) => {
    expect(runLib('rollback_image_tag "$1"', [image])).toBe(expected);
  });

  it("keeps only the newest update backups", () => {
    const dir = tempDir("ve-update-backups-");
    for (const name of ["update-20260101T000000Z", "update-20260301T000000Z", "update-20260201T000000Z", "manual"]) {
      mkdirSync(join(dir, name));
    }
    runLib('prune_update_backups "$1" 2', [dir]);
    expect(readdirSync(dir).sort()).toEqual(["manual", "update-20260201T000000Z", "update-20260301T000000Z"]);
  });

  it("generates systemd units that run the updater as the deploying user", () => {
    const units = runLib('updater_units /srv/ve /srv/ve/data deploy docker /home/deploy /usr/bin:/bin');
    expect(units).toContain("PathExists=/srv/ve/data/update.request");
    expect(units).toContain("User=deploy\nGroup=docker");
    expect(units).toContain("ExecStart=/srv/ve/scripts/update.sh --from-request");
    expect(units).toContain("Environment=DATA_DIR=/srv/ve/data");
    expect(() => runLib('updater_units "/srv/my ve" /srv/ve/data deploy docker /home/deploy /usr/bin 2>/dev/null')).toThrow();
  });
});

// ─── End-to-end update runs against a Git fixture with fake docker/curl/start.sh ───

const FAKE_DOCKER = `#!/usr/bin/env bash
state="$FAKE_STATE"
printf 'docker %s\\n' "$*" >> "$state/log"
case "$1" in
  inspect)
    case "$*" in
      *image.version*) cat "$state/version" ;;
      *State.Running*) echo true ;;
      *Config.Env*) echo "PATH=/usr/bin" ;;
    esac ;;
  image)
    if [[ -n "\${FAKE_MISSING_RELEASE_IMAGES:-}" && "$*" == *:0.4.0* ]]; then exit 1; fi ;;
  pull)
    if [[ -n "\${FAKE_MISSING_RELEASE_IMAGES:-}" ]]; then exit 1; fi ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
for arg; do url="$arg"; done
case "$url" in
  */health)
    if [[ "$(cat "$FAKE_STATE/version")" == "\${FAKE_UNHEALTHY_VERSION:-none}" ]]; then exit 22; fi ;;
  *) printf '{"tag_name": "v0.4.0"}' ;;
esac
`;

// Stands in for scripts/start.sh: "runs" the version selected by VE_IMAGE_TAG
// (the environment first, then .env) and lets a new version migrate the database.
const FAKE_START = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/start-lib.sh
load_dotenv .env
version="\${VE_IMAGE_TAG:-0.3.0}"
printf 'start %s\\n' "$version" >> "$FAKE_STATE/log"
printf '%s\\n' "$version" > "$FAKE_STATE/version"
if [[ "$version" != "0.3.0" ]]; then printf 'migrated-%s\\n' "$version" >> data/virtual-engineer.db; fi
`;

interface Fixture {
  deploy: string;
  state: string;
  bin: string;
  releaseCommit: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(): Fixture {
  const root = tempDir("ve-update-e2e-");
  const source = join(root, "source");
  const deploy = join(root, "deploy");
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(state);
  mkdirSync(bin);
  for (const name of ["update.sh", "update-lib.sh", "start-lib.sh"]) {
    cpSync(join("scripts", name), join(source, "scripts", name));
  }
  writeFileSync(join(source, "scripts", "start.sh"), FAKE_START);
  chmodSync(join(source, "scripts", "start.sh"), 0o755);
  writeFileSync(join(source, ".gitignore"), "data/\n.env\n");
  writeFileSync(join(source, "package.json"), '{\n  "name": "virtual-engineer",\n  "version": "0.3.0",\n}\n');
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.email", "tests@example.invalid");
  git(source, "config", "user.name", "Virtual Engineer Tests");
  git(source, "add", ".");
  git(source, "commit", "-m", "0.3.0");
  git(source, "checkout", "-q", "-b", "release");
  writeFileSync(join(source, "package.json"), '{\n  "name": "virtual-engineer",\n  "version": "0.4.0",\n}\n');
  git(source, "commit", "-am", "0.4.0");
  git(source, "tag", "v0.4.0");
  const releaseCommit = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-q", "main");
  execFileSync("git", ["clone", "--quiet", source, deploy]);

  mkdirSync(join(deploy, "data"));
  writeFileSync(join(deploy, "data", "virtual-engineer.db"), "original\n");
  writeFileSync(join(deploy, ".env"), "ADMIN_API_PORT=3100\nSHUTDOWN_DRAIN_TIMEOUT_MS=0\n");
  writeFileSync(join(state, "version"), "0.3.0\n");
  writeFileSync(join(state, "log"), "");
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  return { deploy, state, bin, releaseCommit };
}

function runUpdate(fixture: Fixture, args: string[], env: Record<string, string> = {}): { status: number; output: string } {
  const result = spawnSync("bash", [join(fixture.deploy, "scripts", "update.sh"), ...args], {
    cwd: fixture.deploy,
    encoding: "utf8",
    env: {
      PATH: `${fixture.bin}:${process.env["PATH"] ?? ""}`,
      HOME: fixture.deploy,
      FAKE_STATE: fixture.state,
      VE_UPDATE_HEALTH_TIMEOUT: "1",
      ...env,
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function readStatus(fixture: Fixture): Record<string, string> {
  const text = readFileSync(join(fixture.deploy, "data", "update.status"), "utf8");
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function dockerLog(fixture: Fixture): string[] {
  return readFileSync(join(fixture.state, "log"), "utf8").trim().split("\n");
}

describe("update.sh", () => {
  it("pulls first, drains the orchestrator, then starts the release from its tag", () => {
    const fixture = createFixture();

    const result = runUpdate(fixture, ["0.4.0"]);

    expect(result.status, result.output).toBe(0);
    expect(readStatus(fixture)).toMatchObject({ state: "succeeded", from: "0.3.0", to: "0.4.0" });
    expect(git(fixture.deploy, "rev-parse", "HEAD")).toBe(fixture.releaseCommit);
    expect(readFileSync(join(fixture.deploy, ".env"), "utf8")).toContain("VE_IMAGE_TAG=0.4.0\n");
    const log = dockerLog(fixture);
    const firstImageCheck = log.findIndex((line) => line.includes("image inspect docker.io/savoirfairelinux/virtual-engineer:0.4.0"));
    const stop = log.indexOf("docker stop --time 30 ve-orchestrator");
    const start = log.indexOf("start 0.4.0");
    expect(firstImageCheck).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(firstImageCheck);
    expect(start).toBeGreaterThan(stop);
    expect(log).toContain("docker tag virtual-engineer:latest virtual-engineer:ve-rollback");
    const backups = readdirSync(join(fixture.deploy, "data", "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture.deploy, "data", "backups", backups[0]!, "database", "virtual-engineer.db"), "utf8")).toBe("original\n");
  });

  it("restores the database, .env, checkout and images when the release is unhealthy", () => {
    const fixture = createFixture();

    const result = runUpdate(fixture, ["0.4.0"], { FAKE_UNHEALTHY_VERSION: "0.4.0" });

    expect(result.status, result.output).toBe(1);
    expect(readStatus(fixture)).toMatchObject({ state: "rolled_back", from: "0.3.0", to: "0.4.0" });
    expect(readStatus(fixture)["message"]).toContain("did not become healthy");
    expect(git(fixture.deploy, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(join(fixture.deploy, ".env"), "utf8")).not.toContain("VE_IMAGE_TAG");
    expect(readFileSync(join(fixture.deploy, "data", "virtual-engineer.db"), "utf8")).toBe("original\n");
    const log = dockerLog(fixture);
    expect(log).toContain("docker tag virtual-engineer:ve-rollback virtual-engineer:latest");
    expect(log.at(-1)).toBe("start 0.3.0");
    expect(readFileSync(join(fixture.state, "version"), "utf8").trim()).toBe("0.3.0");
  });

  it("changes nothing when the release images cannot be pulled", () => {
    const fixture = createFixture();

    const result = runUpdate(fixture, [], { FAKE_MISSING_RELEASE_IMAGES: "1" });

    expect(result.status).toBe(1);
    expect(readStatus(fixture)).toMatchObject({ state: "failed", to: "0.4.0" });
    expect(readStatus(fixture)["message"]).toContain("Nothing was changed");
    expect(dockerLog(fixture).some((line) => line.startsWith("docker stop"))).toBe(false);
    expect(git(fixture.deploy, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(fixture.deploy, "data", "backups"))).toBe(false);
  });

  it("refuses to downgrade below the running version", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.state, "version"), "0.5.0\n");

    const result = runUpdate(fixture, ["0.4.0"]);

    expect(result.status).toBe(1);
    expect(readStatus(fixture)).toMatchObject({ state: "failed", from: "0.5.0", to: "0.4.0" });
    expect(dockerLog(fixture).some((line) => line.startsWith("docker stop"))).toBe(false);
  });

  it("consumes an admin UI request before updating", () => {
    const fixture = createFixture();
    const request = join(fixture.deploy, "data", "update.request");
    writeFileSync(request, "version=0.4.0\nrequested_by=admin\n");

    const result = runUpdate(fixture, ["--from-request"]);

    expect(result.status, result.output).toBe(0);
    expect(existsSync(request)).toBe(false);
    expect(readStatus(fixture)).toMatchObject({ state: "succeeded", to: "0.4.0" });
  });

  it("refuses to update a checkout with local changes", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.deploy, "package.json"), "{}\n");

    const result = runUpdate(fixture, ["0.4.0"]);

    expect(result.status).toBe(1);
    expect(readStatus(fixture)["message"]).toContain("local changes");
  });
});
