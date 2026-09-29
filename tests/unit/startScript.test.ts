import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBackupKeyring } from "../../src/backup/backupCrypto.js";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runHelper(script: string, args: string[] = [], env?: NodeJS.ProcessEnv): string {
  return execFileSync("bash", ["-c", `source scripts/start.sh; ${script}`, "test", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  }).trim();
}

function runDeployHelper(script: string, args: string[] = []): string {
  return execFileSync("bash", ["-c", `source deploy/k8s/deploy-lib.sh; ${script}`, "test", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function createInstallerFixture(): { fixtureDir: string; argsFile: string } {
  const fixtureDir = mkdtempSync(join(tmpdir(), "ve-install-fixture-"));
  tempDirs.push(fixtureDir);
  const scriptsDir = join(fixtureDir, "scripts");
  const argsDir = mkdtempSync(join(tmpdir(), "ve-install-args-"));
  tempDirs.push(argsDir);
  const argsFile = join(argsDir, "start-args.txt");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(fixtureDir, ".env.example"), "ADMIN_AUTH_SECRET=\nLOG_LEVEL=info\n");
  writeFileSync(
    join(scriptsDir, "start.sh"),
    '#!/usr/bin/env bash\nprintf \'%s\' "$*" > "$VE_TEST_START_ARGS_FILE"\n',
  );
  chmodSync(join(scriptsDir, "start.sh"), 0o755);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: fixtureDir, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: fixtureDir });
  execFileSync("git", ["config", "user.name", "Virtual Engineer Tests"], { cwd: fixtureDir });
  execFileSync("git", ["add", ".env.example", "scripts/start.sh"], { cwd: fixtureDir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: fixtureDir, encoding: "utf8" });
  return { fixtureDir, argsFile };
}

function createFakeDockerBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), "ve-install-bin-"));
  tempDirs.push(binDir);
  const dockerPath = join(binDir, "docker");
  writeFileSync(
    dockerPath,
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  --version) printf "Docker version 99.0.0\\n" ;;\n  info) exit 0 ;;\n  *) exit 0 ;;\nesac\n',
  );
  chmodSync(dockerPath, 0o755);
  return binDir;
}

function runInstaller(
  cwd: string,
  fixtureDir: string,
  argsFile: string,
  args: string[] = [],
  expectedCommit?: string,
): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${createFakeDockerBin()}:${process.env["PATH"] ?? ""}`,
    VE_REPOSITORY_URL: fixtureDir,
    VE_ALLOW_CUSTOM_REPOSITORY: "true",
    VE_TEST_START_ARGS_FILE: argsFile,
  };
  if (expectedCommit) env["VE_EXPECTED_COMMIT"] = expectedCommit;
  return execFileSync("bash", [join(process.cwd(), "scripts/install.sh"), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

describe("install.sh bootstrap", () => {
  it("clones into ./virtual-engineer from a non-empty directory and delegates arguments", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ve-install-"));
    tempDirs.push(workDir);
    writeFileSync(join(workDir, "unrelated.txt"), "keep me");
    const checkoutDir = join(workDir, "virtual-engineer");
    const { fixtureDir, argsFile } = createInstallerFixture();
    const expectedCommit = execFileSync("git", ["-C", fixtureDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const firstOutput = runInstaller(workDir, fixtureDir, argsFile, ["--no-k3s-install"], expectedCommit);

    expect(firstOutput).toContain("Starting Virtual Engineer.");
    expect(readFileSync(argsFile, "utf8")).toBe("--no-k3s-install");
    expect(existsSync(join(checkoutDir, ".env"))).toBe(false);
    expect(existsSync(join(workDir, "setup.log"))).toBe(false);
    expect(readFileSync(join(workDir, "unrelated.txt"), "utf8")).toBe("keep me");

    rmSync(fixtureDir, { recursive: true, force: true });
    const secondOutput = runInstaller(workDir, fixtureDir, argsFile, [], expectedCommit);

    expect(secondOutput).toContain("existing Virtual Engineer checkout");
    expect(existsSync(join(checkoutDir, ".env"))).toBe(false);
    expect(readFileSync(argsFile, "utf8")).toBe("");
  });

  it("does not generate a replacement ADMIN_AUTH_SECRET when starting with restore", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ve-install-"));
    tempDirs.push(workDir);
    const { fixtureDir, argsFile } = createInstallerFixture();
    const expectedCommit = execFileSync("git", ["-C", fixtureDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const archivePath = join(workDir, "restore.tar.gz.enc");

    runInstaller(workDir, fixtureDir, argsFile, ["--", "--restore", archivePath], expectedCommit);

    expect(readFileSync(argsFile, "utf8")).toBe(`--restore ${archivePath}`);
    expect(existsSync(join(workDir, "setup.log"))).toBe(false);
  });

  it("reuses the current directory when it already is a Virtual Engineer checkout", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ve-install-"));
    tempDirs.push(workDir);
    const checkoutDir = join(workDir, "virtual-engineer");
    const { fixtureDir, argsFile } = createInstallerFixture();
    const expectedCommit = execFileSync("git", ["-C", fixtureDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    runInstaller(workDir, fixtureDir, argsFile, [], expectedCommit);

    const output = runInstaller(checkoutDir, fixtureDir, argsFile, [], expectedCommit);

    expect(output).toContain("existing Virtual Engineer checkout");
    expect(existsSync(join(checkoutDir, "virtual-engineer"))).toBe(false);
  });

  it("refuses to clone when ./virtual-engineer exists and is not Virtual Engineer", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ve-install-"));
    tempDirs.push(workDir);
    const checkoutDir = join(workDir, "virtual-engineer");
    mkdirSync(checkoutDir);
    writeFileSync(join(checkoutDir, "keep.txt"), "do not delete");
    const { fixtureDir, argsFile } = createInstallerFixture();
    const expectedCommit = execFileSync("git", ["-C", fixtureDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    expect(() => runInstaller(workDir, fixtureDir, argsFile, [], expectedCommit)).toThrow();
    expect(readFileSync(join(checkoutDir, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("documents a fixed installation directory without a directory option", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ve-install-"));
    tempDirs.push(workDir);
    const { fixtureDir, argsFile } = createInstallerFixture();

    const usage = runInstaller(workDir, fixtureDir, argsFile, ["--help"]);

    expect(usage).toContain("virtual-engineer");
    expect(usage).not.toContain("--dir");
    expect(usage).not.toContain("VE_INSTALL_DIR");
  });
});

describe("start.sh helpers", () => {
  it("runs --setup-only idempotently and persists an externally configured keyring path", () => {
    const setupDir = mkdtempSync(join(tmpdir(), "ve-setup-script-"));
    tempDirs.push(setupDir);
    const scriptsDir = join(setupDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync("scripts/start.sh", join(scriptsDir, "start.sh"));
    copyFileSync(".env.example", join(setupDir, ".env.example"));

    const homeDir = join(setupDir, "home");
    const keyringFile = join(setupDir, "secrets", "backup-keyring.json");
    const setupEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(setupDir, "config"),
      DATA_DIR: join(setupDir, "data"),
      DATABASE_PATH: join(setupDir, "data", "virtual-engineer.db"),
      BACKUP_DIR: join(setupDir, "data", "backups"),
      BACKUP_KEYRING_FILE: keyringFile,
    };
    delete setupEnv["ADMIN_AUTH_SECRET"];
    const firstOutput = execFileSync("bash", [join(scriptsDir, "start.sh"), "--setup-only"], {
      cwd: setupDir,
      encoding: "utf8",
      env: setupEnv,
    });
    const envFile = join(setupDir, ".env");
    const firstEnv = readFileSync(envFile, "utf8");
    const envExample = readFileSync(join(setupDir, ".env.example"), "utf8");
    const adminSecret = firstEnv.match(/^ADMIN_AUTH_SECRET=([a-f0-9]{64})$/m)?.[1];
    const keyring = JSON.parse(readFileSync(keyringFile, "utf8")) as {
      activeKeyId: string;
      keys: Record<string, string>;
    };
    const backupKey = keyring.keys[keyring.activeKeyId];

    expect(adminSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(backupKey).toMatch(/^[a-f0-9]{64}$/);
    expect(firstEnv.startsWith(envExample)).toBe(true);
    expect(firstOutput).not.toContain(adminSecret);
    expect(firstOutput).not.toContain(backupKey);
    expect(firstEnv).toContain(`BACKUP_KEYRING_FILE=${keyringFile}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(keyringFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(setupDir, "data", ".admin-auth-secret-onboarding-pending"))).toBe(true);
    expect(existsSync(join(setupDir, "data", ".backup-keyring-onboarding-pending"))).toBe(true);

    const secondEnv = { ...setupEnv };
    delete secondEnv["BACKUP_KEYRING_FILE"];
    const secondOutput = execFileSync("bash", [join(scriptsDir, "start.sh"), "--setup-only"], {
      cwd: setupDir,
      encoding: "utf8",
      env: secondEnv,
    });

    expect(readFileSync(envFile, "utf8")).toBe(firstEnv);
    expect(readFileSync(keyringFile, "utf8")).toBe(JSON.stringify(keyring) + "\n");
    expect(secondOutput).not.toContain(adminSecret);
    expect(secondOutput).not.toContain(backupKey);
  });

  it("fills missing .env defaults without overwriting configured values", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-env-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "LOG_LEVEL=warn\nCUSTOM_SETTING=keep\nADMIN_AUTH_SECRET=existing\n");

    runHelper('ensure_env_file "$1" "$2"', [envFile, join(process.cwd(), ".env.example")]);

    const envContent = readFileSync(envFile, "utf8");
    expect(envContent).toContain("NODE_ENV=development");
    expect(envContent).toContain("LOG_LEVEL=warn");
    expect(envContent.match(/^LOG_LEVEL=/gm)).toHaveLength(1);
    expect(envContent).toContain("CUSTOM_SETTING=keep");
    expect(envContent).toContain("ADMIN_AUTH_SECRET=existing");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("provisions both missing secrets once and keeps them private", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-setup-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const dataDir = join(dir, "data");
    const databasePath = join(dataDir, "virtual-engineer.db");
    const backupDir = join(dataDir, "backups");
    const configHome = join(dir, "config");
    const homeDir = join(dir, "home");
    mkdirSync(dataDir);
    writeFileSync(envFile, "ADMIN_AUTH_SECRET=\nLOG_LEVEL=info\n");
    const helper = [
      "unset ADMIN_AUTH_SECRET BACKUP_KEYRING_FILE",
      'load_dotenv "$1"',
      'ensure_instance_secrets "$1" "$2" "$3" "$4" "$5" "$6"',
    ].join("; ");

    const output = runHelper(helper, [envFile, dataDir, databasePath, backupDir, configHome, homeDir]);
    const envContent = readFileSync(envFile, "utf8");
    const adminSecret = envContent.match(/^ADMIN_AUTH_SECRET=([a-f0-9]{64})$/m)?.[1];
    const keyringPath = join(configHome, "virtual-engineer", "backup-keyring.json");
    const keyring = JSON.parse(readFileSync(keyringPath, "utf8")) as {
      activeKeyId: string;
      keys: Record<string, string>;
    };
    const backupKey = keyring.keys[keyring.activeKeyId];

    expect(adminSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(backupKey).toMatch(/^[a-f0-9]{64}$/);
    expect(output).not.toContain(adminSecret);
    expect(output).not.toContain(backupKey);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(keyringPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, ".secrets-provisioned"))).toBe(true);
    expect(existsSync(join(dataDir, ".backup-keyring-onboarding-pending"))).toBe(true);
    expect(existsSync(join(dataDir, ".admin-auth-secret-onboarding-pending"))).toBe(true);
    expect(envContent).toContain(`BACKUP_KEYRING_FILE=${keyringPath}`);

    const originalKeyring = readFileSync(keyringPath, "utf8");
    const originalEnv = readFileSync(envFile, "utf8");
    rmSync(join(dataDir, ".backup-keyring-onboarding-pending"));
    rmSync(join(dataDir, ".admin-auth-secret-onboarding-pending"));
    runHelper(helper, [envFile, dataDir, databasePath, backupDir, configHome, homeDir]);

    expect(readFileSync(keyringPath, "utf8")).toBe(originalKeyring);
    expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
    expect(existsSync(join(dataDir, ".backup-keyring-onboarding-pending"))).toBe(false);
    expect(existsSync(join(dataDir, ".admin-auth-secret-onboarding-pending"))).toBe(false);
  });

  it("refuses to generate replacement secrets after an instance was provisioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-setup-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const dataDir = join(dir, "data");
    const databasePath = join(dataDir, "virtual-engineer.db");
    const backupDir = join(dataDir, "backups");
    const configHome = join(dir, "config");
    const homeDir = join(dir, "home");
    mkdirSync(dataDir);
    writeFileSync(envFile, "ADMIN_AUTH_SECRET=\n");
    const helper = [
      "unset ADMIN_AUTH_SECRET BACKUP_KEYRING_FILE",
      'load_dotenv "$1"',
      'ensure_instance_secrets "$1" "$2" "$3" "$4" "$5" "$6"',
    ].join("; ");

    runHelper(helper, [envFile, dataDir, databasePath, backupDir, configHome, homeDir]);
    const originalKeyring = join(configHome, "virtual-engineer", "backup-keyring.json");
    const originalEnv = readFileSync(envFile, "utf8");
    rmSync(originalKeyring);

    expect(() => runHelper(helper, [envFile, dataDir, databasePath, backupDir, configHome, homeDir])).toThrow();
    expect(readFileSync(envFile, "utf8")).toBe(originalEnv);
    expect(existsSync(originalKeyring)).toBe(false);
  });

  it("refuses first-time generation when database or backup data already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-setup-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const dataDir = join(dir, "data");
    const databasePath = join(dataDir, "virtual-engineer.db");
    const backupDir = join(dataDir, "backups");
    const configHome = join(dir, "config");
    const homeDir = join(dir, "home");
    mkdirSync(dataDir);
    writeFileSync(envFile, "ADMIN_AUTH_SECRET=\n");
    writeFileSync(databasePath, "existing database");
    const helper = [
      "unset ADMIN_AUTH_SECRET BACKUP_KEYRING_FILE",
      'load_dotenv "$1"',
      'ensure_instance_secrets "$1" "$2" "$3" "$4" "$5" "$6"',
    ].join("; ");

    expect(() => runHelper(helper, [envFile, dataDir, databasePath, backupDir, configHome, homeDir])).toThrow();
    expect(readFileSync(envFile, "utf8")).toBe("ADMIN_AUTH_SECRET=\n");
    expect(existsSync(join(configHome, "virtual-engineer", "backup-keyring.json"))).toBe(false);
  });

  it("generates and persists a private ADMIN_AUTH_SECRET once when it is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-auth-secret-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "ADMIN_AUTH_SECRET=\nLOG_LEVEL=info\n");
    const helper = 'unset ADMIN_AUTH_SECRET; load_dotenv "$1"; ensure_admin_auth_secret "$1"; printf "%s" "$ADMIN_AUTH_SECRET"';

    const firstSecret = runHelper(helper, [envFile]);
    const firstContent = readFileSync(envFile, "utf8");

    expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(firstContent.match(/^ADMIN_AUTH_SECRET=/gm)).toHaveLength(1);
    expect(firstContent).toContain(`ADMIN_AUTH_SECRET=${firstSecret}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const secondSecret = runHelper(helper, [envFile]);

    expect(secondSecret).toBe(firstSecret);
    expect(readFileSync(envFile, "utf8")).toBe(firstContent);
  });

  it("preserves an existing ADMIN_AUTH_SECRET from .env or the process environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-auth-secret-"));
    tempDirs.push(dir);
    const envFile = join(dir, ".env");
    const storedSecret = "b".repeat(64);
    const externalSecret = "c".repeat(64);
    const storedContent = `ADMIN_AUTH_SECRET=${storedSecret}\nLOG_LEVEL=info\n`;
    writeFileSync(envFile, storedContent);

    const fromDotenv = runHelper(
      'unset ADMIN_AUTH_SECRET; load_dotenv "$1"; ensure_admin_auth_secret "$1"; printf "%s" "$ADMIN_AUTH_SECRET"',
      [envFile],
    );
    const fromEnvironment = runHelper(
      'load_dotenv "$1"; ensure_admin_auth_secret "$1"; printf "%s" "$ADMIN_AUTH_SECRET"',
      [envFile],
      { ADMIN_AUTH_SECRET: externalSecret },
    );

    expect(fromDotenv).toBe(storedSecret);
    expect(fromEnvironment).toBe(externalSecret);
    expect(readFileSync(envFile, "utf8")).toBe(storedContent);
  });

  it("explains the backup keyring requirement when it is not configured", () => {
    const notice = runHelper('backup_keyring_startup_notice "$1"', [""]);

    expect(notice).toContain("new backups and encrypted restores will fail");
    expect(notice).toContain("BACKUP_KEYRING_FILE");
    expect(notice).toContain("README.md");
  });

  it("does not show the backup keyring notice when it is configured", () => {
    expect(runHelper(
      'backup_keyring_startup_notice "$1"',
      ["/secure/backup-keyring.json"],
    )).toBe("");
  });

  it("creates and reuses a private versioned default backup keyring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-keyring-"));
    tempDirs.push(dir);
    const configHome = join(dir, "config");
    const homeDir = join(dir, "home");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    const helper = 'ensure_default_backup_keyring_file "$1" "$2" "$3"; printf "%s\\n%s" "$BACKUP_KEYRING_FILE" "$BACKUP_KEYRING_CREATED"';

    const firstResult = runHelper(helper, [configHome, homeDir, dataDir]).split("\n");
    const keyringPath = firstResult[0];
    expect(keyringPath).toBe(join(configHome, "virtual-engineer", "backup-keyring.json"));
    expect(firstResult[1]).toBe("true");
    if (!keyringPath) throw new Error("Expected a generated backup keyring path");

    const keyring = JSON.parse(readFileSync(keyringPath, "utf8")) as {
      format: string;
      version: number;
      activeKeyId: string;
      keys: Record<string, string>;
    };
    expect(keyring.format).toBe("virtual-engineer-backup-keyring");
    expect(keyring.version).toBe(1);
    expect(keyring.keys[keyring.activeKeyId]).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(keyringPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, "virtual-engineer")).mode & 0o777).toBe(0o700);
    const markerPath = join(dataDir, ".backup-keyring-onboarding-pending");
    expect(existsSync(markerPath)).toBe(true);
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    const loadedKeyring = await loadBackupKeyring(keyringPath);
    expect(loadedKeyring.activeKeyId).toBe(keyring.activeKeyId);
    expect(loadedKeyring.keys.get(keyring.activeKeyId)?.byteLength).toBe(32);

    const originalContent = readFileSync(keyringPath, "utf8");
    rmSync(markerPath);
    const secondResult = runHelper(helper, [configHome, homeDir, dataDir]).split("\n");
    expect(secondResult).toEqual([keyringPath, "false"]);
    expect(readFileSync(keyringPath, "utf8")).toBe(originalContent);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("uses HOME config when XDG_CONFIG_HOME is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-keyring-"));
    tempDirs.push(dir);
    const homeDir = join(dir, "home");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);

    const result = runHelper(
      'ensure_default_backup_keyring_file "" "$1" "$2"; printf "%s\\n%s" "$BACKUP_KEYRING_FILE" "$BACKUP_KEYRING_CREATED"',
      [homeDir, dataDir],
    ).split("\n");

    expect(result).toEqual([
      join(homeDir, ".config", "virtual-engineer", "backup-keyring.json"),
      "true",
    ]);
  });

  it("refuses to create the default keyring inside DATA_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-keyring-"));
    tempDirs.push(dir);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);

    expect(() => runHelper(
      'ensure_default_backup_keyring_file "$1" "$2" "$3"',
      [join(dataDir, "config"), join(dir, "home"), dataDir],
    )).toThrow();
  });

  it("provisions secrets only for normal starts after option validation", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const optionValidationIndex = script.indexOf('REVIEW_DIFF_TMPFS_SIZE=$(normalize_review_diff_tmpfs_size "${REVIEW_DIFF_TMPFS_SIZE:-}")');
    const ensureIndex = script.lastIndexOf('ensure_instance_secrets "$ROOT_DIR/.env"');

    expect(optionValidationIndex).toBeGreaterThan(-1);
    expect(ensureIndex).toBeGreaterThan(optionValidationIndex);
    expect(script).toContain('if [[ -n "$RESTORE_ARCHIVE" ]]; then');
  });

  it("provisions secrets on normal starts, preserves process overrides, and skips restore", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const secretSetup = script.lastIndexOf('ensure_instance_secrets "$ROOT_DIR/.env"');
    const dockerArgs = script.indexOf('DOCKER_RUN_ARGS=(');
    const restoreBranch = script.lastIndexOf('if [[ -n "$RESTORE_ARCHIVE" ]]; then', secretSetup);

    expect(secretSetup).toBeGreaterThan(-1);
    expect(restoreBranch).toBeGreaterThan(-1);
    expect(script.slice(restoreBranch, secretSetup)).toContain("confirm_backup_restore");
    expect(script.slice(restoreBranch, secretSetup)).not.toContain("ensure_instance_secrets");
    expect(secretSetup).toBeLessThan(dockerArgs);
    expect(script).toContain("-e ADMIN_AUTH_SECRET");
  });

  it("keeps setup and startup in one script and delegates directly from the installer", () => {
    const startScript = readFileSync("scripts/start.sh", "utf8");
    const installerScript = readFileSync("scripts/install.sh", "utf8");

    expect(startScript).toContain("--setup-only");
    expect(startScript).not.toContain('source "$SCRIPT_DIR/start-lib.sh"');
    expect(installerScript).not.toContain("setup.sh");
    expect(installerScript).toContain('bash "${INSTALL_DIR}/scripts/start.sh"');
    expect(existsSync("scripts/setup.sh")).toBe(false);
    expect(existsSync("scripts/start-lib.sh")).toBe(false);
  });

  it("shows the backup keyring notice after loading .env", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const dotenvIndex = script.indexOf('load_dotenv "$ROOT_DIR/.env"');
    const noticeIndex = script.indexOf('backup_keyring_startup_notice "${BACKUP_KEYRING_FILE:-}"');
    const optionValidationIndex = script.indexOf('REVIEW_DIFF_TMPFS_SIZE=$(normalize_review_diff_tmpfs_size "${REVIEW_DIFF_TMPFS_SIZE:-}")');

    expect(dotenvIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeGreaterThan(dotenvIndex);
    expect(noticeIndex).toBeGreaterThan(optionValidationIndex);
  });

  it("accepts only an existing regular restore archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-restore-"));
    tempDirs.push(dir);
    const archivePath = join(dir, "backup.tar.gz");
    const symlinkPath = join(dir, "backup-link.tar.gz");
    writeFileSync(archivePath, "archive");
    symlinkSync(archivePath, symlinkPath);

    expect(runHelper('resolve_restore_archive "$1"', [archivePath])).toBe(archivePath);
    expect(() => runHelper('resolve_restore_archive "$1"', [symlinkPath])).toThrow();
    expect(() => runHelper('resolve_restore_archive "$1"', [join(dir, "missing.tar.gz")])).toThrow();
  });

  it("requires a regular backup keyring outside DATA_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-keyring-"));
    tempDirs.push(dir);
    const dataDir = join(dir, "data");
    const keyringPath = join(dir, "backup-keyring.json");
    const nestedKeyringPath = join(dataDir, "backup-keyring.json");
    mkdirSync(dataDir);
    writeFileSync(keyringPath, "{}\n");
    writeFileSync(nestedKeyringPath, "{}\n");

    expect(runHelper('resolve_backup_keyring_file "$1" "$2"', [keyringPath, dataDir])).toBe(keyringPath);
    expect(() => runHelper('resolve_backup_keyring_file "$1" "$2"', [nestedKeyringPath, dataDir])).toThrow();
    expect(() => runHelper('resolve_backup_keyring_file "$1" "$2"', [join(dir, "missing.json"), dataDir])).toThrow();
  });

  it("requires interactive restore confirmation or an explicit yes flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-restore-"));
    tempDirs.push(dir);
    const archivePath = join(dir, "backup.tar.gz");
    writeFileSync(archivePath, "archive");

    expect(runHelper(
      'if confirm_backup_restore "$1" "$2" "$3"; then printf yes; fi',
      [archivePath, join(dir, "data"), "true"],
    )).toBe("yes");
    expect(() => runHelper(
      'confirm_backup_restore "$1" "$2" "$3"',
      [archivePath, join(dir, "data"), "false"],
    )).toThrow();
  });

  it("mounts a requested restore archive and stops the old instance first", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain("--restore <archive> [--force] [--yes]");
    expect(script).toContain("--yes");
    expect(script).toContain("target=/app/restore-backup,readonly");
    expect(script).toContain("VE_RESTORE_FROM=/app/restore-backup");
    expect(script).toContain("target=/app/backup-keyring.json,readonly");
    expect(script).toContain("BACKUP_KEYRING_FILE=/app/backup-keyring.json");
    expect(script).toContain("VE_RESTORE_FORCE=true");
    const stopIndex = script.indexOf("Stopping the existing ve-orchestrator before restore");
    const startIndex = script.indexOf('docker run "${DOCKER_RUN_ARGS[@]}" virtual-engineer:latest');
    expect(stopIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(stopIndex);
    expect(script).toContain('docker rm -f ve-orchestrator');
  });

  it.each([
    { value: "", expected: "2g" },
    { value: "512m", expected: "512m" },
    { value: "4g", expected: "4g" },
  ])("resolves a bounded review diff tmpfs size: '$value'", ({ value, expected }) => {
    expect(runHelper('normalize_review_diff_tmpfs_size "$1"', [value])).toBe(expected);
  });

  it.each(["0", "0m", "0g", "-1g", "unlimited", "2.5g", "2g,exec", "100%"])(
    "rejects an invalid review diff tmpfs size: %s",
    (value) => {
      expect(() => runHelper('normalize_review_diff_tmpfs_size "$1"', [value])).toThrow();
    },
  );

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

  it("waits until the container log reports the expected line", () => {
    const binDir = mkdtempSync(join(tmpdir(), "ve-start-bin-"));
    tempDirs.push(binDir);
    const counterFile = join(binDir, "attempts");
    writeFileSync(
      join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        `count=$(cat "${counterFile}" 2>/dev/null || true)`,
        'count=${count:-0}',
        `printf '%s' "$((count + 1))" > "${counterFile}"`,
        '[ "$count" -ge 1 ] && printf \'Server listening address=0.0.0.0:30808\\n\'',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(binDir, "docker"), 0o755);
    const env = { PATH: `${binDir}:${process.env["PATH"] ?? ""}` };

    const found = runHelper(
      'if wait_for_container_log ve-openshell-gateway "Server listening" 5; then printf yes; else printf no; fi',
      [],
      env,
    );
    const missing = runHelper(
      'if wait_for_container_log ve-openshell-gateway "Compute driver connected" 2; then printf yes; else printf no; fi',
      [],
      env,
    );

    expect(found).toBe("yes");
    expect(missing).toBe("no");
  });

  it("consumes the full container log stream without hiding docker failures", () => {
    const binDir = mkdtempSync(join(tmpdir(), "ve-start-bin-"));
    tempDirs.push(binDir);
    writeFileSync(
      join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "printf 'Server listening address=0.0.0.0:30808\\n'",
        'if [[ "${VE_TEST_DOCKER_FAILURE:-}" == "true" ]]; then exit 42; fi',
        "trap 'exit 141' PIPE",
        "for ((line = 0; line < 10000; line++)); do",
        "  printf 'post-match log line %s padding padding padding\\n' \"$line\" || exit 141",
        "done",
      ].join("\n"),
    );
    chmodSync(join(binDir, "docker"), 0o755);
    const baseEnv = { PATH: `${binDir}:${process.env["PATH"] ?? ""}` };
    const script =
      'set -o pipefail; if wait_for_container_log ve-openshell-gateway "Server listening" 1; then printf yes; else printf no; fi';

    expect(runHelper(script, [], baseEnv)).toBe("yes");
    expect(runHelper(script, [], { ...baseEnv, VE_TEST_DOCKER_FAILURE: "true" })).toBe("no");
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

  it.each([
    {
      configuredDir: "/tmp/ve-state",
      xdgStateHome: "/tmp/xdg-state",
      homeDir: "/home/test",
      expected: "/tmp/ve-state",
    },
    {
      configuredDir: "",
      xdgStateHome: "/tmp/xdg-state",
      homeDir: "/home/test",
      expected: "/tmp/xdg-state/virtual-engineer",
    },
    {
      configuredDir: "",
      xdgStateHome: "",
      homeDir: "/home/test",
      expected: "/home/test/.local/state/virtual-engineer",
    },
  ])("resolves managed OpenShell state outside the checkout", ({ configuredDir, xdgStateHome, homeDir, expected }) => {
    expect(runHelper(
      'resolve_openshell_state_dir "$1" "$2" "$3"',
      [configuredDir, xdgStateHome, homeDir],
    )).toBe(expected);
  });

  it("refuses to resolve managed OpenShell state without a location outside the checkout", () => {
    expect(() => runHelper('resolve_openshell_state_dir "$1" "$2" "$3"', ["", "", ""])).toThrow();
  });

  it("refuses to migrate local OIDC secrets into a symlinked state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const legacyDir = join(dir, "legacy", "local-oidc");
    const elsewhere = join(dir, "elsewhere");
    const stateDir = join(dir, "state", "local-oidc");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(dir, "state"), { recursive: true });
    symlinkSync(elsewhere, stateDir);
    writeFileSync(join(legacyDir, "client-secret"), "legacy-client-secret\n");

    expect(() => runHelper('migrate_local_oidc_state "$1" "$2"', [legacyDir, stateDir])).toThrow();
    expect(existsSync(join(elsewhere, "client-secret"))).toBe(false);
  });

  it("refuses to migrate local OIDC secrets over a non-regular target", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const legacyDir = join(dir, "legacy", "local-oidc");
    const stateDir = join(dir, "state", "local-oidc");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(join(stateDir, "client-secret"), { recursive: true });
    writeFileSync(join(legacyDir, "client-secret"), "legacy-client-secret\n");

    expect(() => runHelper('migrate_local_oidc_state "$1" "$2"', [legacyDir, stateDir])).toThrow();
  });

  it("migrates legacy local OIDC secrets without overwriting newer state", () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-start-test-"));
    tempDirs.push(dir);
    const legacyDir = join(dir, "legacy", "local-oidc");
    const stateDir = join(dir, "state", "local-oidc");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(legacyDir, "client-secret"), "legacy-client-secret\n");
    writeFileSync(join(legacyDir, "admin-password"), "legacy-admin-password\n");
    writeFileSync(join(stateDir, "client-secret"), "new-client-secret\n");

    runHelper('migrate_local_oidc_state "$1" "$2"', [legacyDir, stateDir]);

    expect(readFileSync(join(stateDir, "client-secret"), "utf8")).toBe("new-client-secret\n");
    expect(readFileSync(join(stateDir, "admin-password"), "utf8")).toBe("legacy-admin-password\n");
    expect(statSync(join(stateDir, "admin-password")).mode & 0o777).toBe(0o600);
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
  it("formats orchestrator logs in the host's local timezone", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const logger = readFileSync("src/logger.ts", "utf8");

    expect(script).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(script).toContain('-e "TZ=$ORCHESTRATOR_TIMEZONE"');
    expect(logger).toContain('translateTime: "SYS:HH:MM:ss"');
  });

  it("passes the invoking user's group for read-only backup access", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain('BACKUP_ACCESS_GID="${BACKUP_ACCESS_GID:-${SUDO_GID:-$(id -g)}}"');
    expect(script).toContain('-e "BACKUP_ACCESS_GID=$BACKUP_ACCESS_GID"');
  });

  it("keeps review diffs in a configurable size-limited tmpfs", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain('REVIEW_DIFF_TMPFS_SIZE=$(normalize_review_diff_tmpfs_size "${REVIEW_DIFF_TMPFS_SIZE:-}")');
    expect(script).toContain('--tmpfs "/tmp/ve-review-diffs:rw,size=${REVIEW_DIFF_TMPFS_SIZE}"');
    expect(script.indexOf("REVIEW_DIFF_TMPFS_SIZE=$("))
      .toBeLessThan(script.indexOf('ensure_dir "$DATA_DIR"'));
    expect(script).toContain('run_config_hash "$ROOT_DIR/.env" "${DOCKER_RUN_ARGS[@]}"');
  });

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
    expect(script.match(/stop_managed_openshell_port_forward/g)).toHaveLength(3);
    expect(script).toContain('OPENSHELL_GATEWAY_JWT_HASH=$(docker run --rm');
    expect(script).not.toContain('sha256sum "${OPENSHELL_GATEWAY_PKI_DIR}/jwt/public.pem"');
    expect(script).toContain("docker network inspect openshell-docker");
    expect(script).toContain("OPENSHELL_DOCKER_BRIDGE_IP=");
    expect(script).toContain('-p "${OPENSHELL_DOCKER_BRIDGE_IP}:${OPENSHELL_GW_LOCAL_PORT}:${OPENSHELL_GW_LOCAL_PORT}"');
  });

  it("gates gateway registration on a listening gateway and retries the status call", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain('wait_for_container_log ve-openshell-gateway "Server listening"');
    expect(script).toContain('[[ "$_gateway_up" != "true" ]]');
    expect(script).toContain("OpenShell Docker gateway OIDC authentication failed");
    expect(script).toContain("did not accept an authenticated connection");
    const registrationIdx = script.indexOf("OpenShell Docker gateway OIDC authentication failed");
    const statusIdx = script.indexOf("did not accept an authenticated connection");
    expect(registrationIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(registrationIdx);
    expect(script).toContain('openshell status 2>&1)');
  });

  it("reclaims root-owned CLI config before creating the mTLS directory", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain('reclaim_root_owned_tree "${OPENSHELL_CONFIG_DIR}/openshell"');
    const reclaimIdx = script.indexOf('reclaim_root_owned_tree "${OPENSHELL_CONFIG_DIR}/openshell"');
    const installIdx = script.indexOf('install -d -m 0700 "$OPENSHELL_MTLS_DIR"');
    expect(reclaimIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(reclaimIdx);
  });

  it("detects a stale Kubernetes-mode Keycloak realm before registering the gateway", () => {
    const script = readFileSync("scripts/start.sh", "utf8");

    expect(script).toContain("its PVC-persisted realm predates that file");
    expect(script).toContain("kubectl delete deployment/ve-local-keycloak pvc/ve-local-keycloak-data");
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

  it("keeps managed local OIDC state outside the replaceable checkout", () => {
    const script = readFileSync("scripts/start.sh", "utf8");
    const envExample = readFileSync(".env.example", "utf8");

    expect(script).toContain("resolve_openshell_state_dir");
    expect(script).not.toContain('"${HOME:-$ROOT_DIR}"');
    expect(script).toContain('LOCAL_OIDC_DIR="${OPENSHELL_STATE_DIR}/local-oidc"');
    expect(script).toContain('LEGACY_LOCAL_OIDC_DIR="${DATA_DIR}/local-oidc"');
    expect(script).toContain('migrate_local_oidc_state "$LEGACY_LOCAL_OIDC_DIR" "$LOCAL_OIDC_DIR"');
    expect(envExample).toContain("OPENSHELL_STATE_DIR=");
  });

  it("builds the agent image with the account required by OpenShell", () => {
    const dockerfile = readFileSync("Dockerfile.agent", "utf8");

    expect(dockerfile).toContain("groupadd --system sandbox");
    expect(dockerfile).toContain("useradd --system --gid sandbox");
    expect(dockerfile).toContain("--home-dir /sandbox");
    expect(dockerfile).toContain("npm install -g opencode-ai@1.18.16");
  });

  it("materializes the Cursor CLI outside root's home", () => {
    const dockerfile = readFileSync("Dockerfile.agent", "utf8");

    expect(dockerfile).toContain(
      'cp -a "$(dirname "$cursor_bin")/." /usr/local/lib/cursor-agent/'
    );
    expect(dockerfile).toContain(
      "ln -s ../lib/cursor-agent/cursor-agent /usr/local/bin/cursor-agent"
    );
    expect(dockerfile).not.toContain(
      "ln -s /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent"
    );
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

  it("validates a selected encrypted StorageClass name", () => {
    expect(runDeployHelper(
      'if valid_storage_class_name "$1"; then printf yes; else printf no; fi',
      ["encrypted-csi.storage.example"],
    )).toBe("yes");
    expect(runDeployHelper(
      'if valid_storage_class_name "$1"; then printf yes; else printf no; fi',
      ["Replace Me"],
    )).toBe("no");
    expect(runDeployHelper(
      'if valid_storage_class_name "$1"; then printf yes; else printf no; fi',
      [""],
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
    expect(deployScript).toContain("VE_ENCRYPTED_STORAGE_CLASS");
    expect(deployScript).toContain("virtual-engineer-backup-keyring");
    expect(deployScript).toContain("storageClassName");
    expect(deployScript).toContain("VE_DATA_PVC_NAME");
    expect(deployScript).toContain("Use a new PVC name for encrypted storage");
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

describe("reset-instance.sh", () => {
  it("parses quoted .env values without an invalid awk regex escape", () => {
    const script = readFileSync("scripts/reset-instance.sh", "utf8");

    expect(script).toContain('gsub(/^"|"$/, "", value)');
    expect(script).not.toContain('gsub(/^\\"|\\"$/, "", value)');

    const tmpDir = mkdtempSync(join(tmpdir(), "ve-reset-instance-"));
    tempDirs.push(tmpDir);
    const envFile = join(tmpDir, "test.env");
    writeFileSync(envFile, 'TEST_KEY = "hello world"\n');
    const result = execFileSync("awk", [
      "-F=", "-v", "key=TEST_KEY",
      `/^[[:space:]]*#/ { next }
       $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
         value = substr($0, index($0, "=") + 1)
         gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
         gsub(/^"|"$/, "", value)
         print value
         exit
       }`,
      envFile,
    ], { encoding: "utf8" });
    expect(result.trim()).toBe("hello world");
  });

  it("resolves the same kubeconfig start.sh uses before uninstalling the Helm release", () => {
    const script = readFileSync("scripts/reset-instance.sh", "utf8");

    expect(script).toContain('K3S_KUBECONFIG="${ROOT_DIR}/data/kubeconfig"');
    expect(script).toContain('K3S_KUBECONFIG="/etc/rancher/k3s/k3s.yaml"');
    const dataKubeconfigIdx = script.indexOf('K3S_KUBECONFIG="${ROOT_DIR}/data/kubeconfig"');
    const helmStatusIdx = script.indexOf('"$HELM_BIN" status openshell');
    expect(dataKubeconfigIdx).toBeGreaterThan(-1);
    expect(helmStatusIdx).toBeGreaterThan(dataKubeconfigIdx);
  });
});