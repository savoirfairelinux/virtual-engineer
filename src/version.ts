import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedGitArgs, trustedGitEnv } from "./utils/gitExec.js";

export interface BuildInfo {
  version: string;
  gitSha: string | undefined;
  buildDate: string | undefined;
}

export interface BuildInfoSources {
  env: NodeJS.ProcessEnv;
  readPackageVersion: () => string;
  readGitSha: () => string | undefined;
}

const UNKNOWN_VERSION = "0.0.0-unknown";
const PACKAGE_NAME = "virtual-engineer";
const moduleDir = dirname(fileURLToPath(import.meta.url));

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function resolveBuildInfo(sources: BuildInfoSources): BuildInfo {
  return {
    version: nonBlank(safely(sources.readPackageVersion)) ?? UNKNOWN_VERSION,
    gitSha: nonBlank(sources.env["VE_GIT_SHA"]) ?? nonBlank(safely(sources.readGitSha)),
    buildDate: nonBlank(sources.env["VE_BUILD_DATE"]),
  };
}

// src/version.ts (tsx) sits one level below the root; dist/src/version.js sits two levels below.
function readRootPackageVersion(): string {
  for (const candidate of [resolve(moduleDir, "../package.json"), resolve(moduleDir, "../../package.json")]) {
    const parsed = safely(() => JSON.parse(readFileSync(candidate, "utf8")) as unknown);
    if (typeof parsed !== "object" || parsed === null) continue;
    const { name, version } = parsed as { name?: unknown; version?: unknown };
    if (name === PACKAGE_NAME && typeof version === "string") return version;
  }
  throw new Error("virtual-engineer package.json not found");
}

function readLocalGitSha(): string | undefined {
  return execFileSync("git", trustedGitArgs(["rev-parse", "--short", "HEAD"]), {
    cwd: moduleDir,
    env: trustedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
}

let cached: BuildInfo | undefined;

export function getBuildInfo(): BuildInfo {
  cached ??= resolveBuildInfo({
    env: process.env,
    readPackageVersion: readRootPackageVersion,
    readGitSha: readLocalGitSha,
  });
  return cached;
}
