import { stringify } from "yaml";

export const OPEN_SHELL_POLICY_KEYS = {
  network: "network_policies",
  filesystem: "filesystem_policy",
  process: "process",
  inference: "inference",
} as const;

export function createDefaultPolicyDocument(): Record<string, unknown> {
  return {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: ["/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log"],
      read_write: ["/sandbox", "/tmp", "/dev/null"],
    },
    landlock: { compatibility: "best_effort" },
    process: {
      run_as_user: "sandbox",
      run_as_group: "sandbox",
    },
  };
}

/** OpenShell 0.0.83's deny-by-default base policy for the VE sandbox image. */
export function buildDefaultPolicyYaml(): string {
  return stringify(createDefaultPolicyDocument());
}
