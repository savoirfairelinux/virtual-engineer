/**
 * OpenShell policy builder — turns a typed {@link RuntimePolicySpec} into the
 * declarative YAML OpenShell's policy engine consumes, and provides the three
 * canonical templates VE ships (review-readonly, coding-registries, deny-strict).
 *
 * The emitter is intentionally specific to VE's policy shape (not a general YAML
 * serializer) so output is deterministic and auditable. All network policies are
 * deny-by-default; callers add explicit allow rules.
 */

/** A single L7 egress allow rule. Omitting `methods` allows all methods. */
export interface NetworkAllowRule {
  host: string;
  /** HTTP methods to allow (L7). Omitted = all methods. */
  methods?: string[];
}

/** Typed policy specification prior to YAML emission. */
export interface RuntimePolicySpec {
  network?: {
    /** Base posture. VE always uses `deny` (deny-by-default). */
    default: "deny" | "allow";
    allow: NetworkAllowRule[];
  };
  filesystem?: {
    allowWrite: string[];
  };
  process?: {
    noNewPrivileges?: boolean;
    dropCaps?: "all";
  };
  inference?: {
    /** Endpoint the sandbox's `inference.local` route forwards to. */
    endpoint: string;
    provider?: string;
    model?: string;
  };
}

function yamlString(value: string): string {
  // Quote values that could be misread as YAML tokens; keep simple hosts bare.
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Emit deterministic OpenShell policy YAML for a {@link RuntimePolicySpec}.
 * Sections are emitted in a fixed order; empty sections are omitted.
 */
export function buildPolicyYaml(spec: RuntimePolicySpec): string {
  const lines: string[] = [];

  if (spec.network) {
    lines.push("network:");
    lines.push(`  default: ${spec.network.default}`);
    if (spec.network.allow.length > 0) {
      lines.push("  allow:");
      for (const rule of spec.network.allow) {
        lines.push(`    - host: ${yamlString(rule.host)}`);
        if (rule.methods && rule.methods.length > 0) {
          lines.push(`      methods: [${rule.methods.map((m) => m.toUpperCase()).join(", ")}]`);
        }
      }
    } else {
      lines.push("  allow: []");
    }
  }

  if (spec.filesystem) {
    lines.push("filesystem:");
    lines.push(`  allow_write: [${spec.filesystem.allowWrite.map(yamlString).join(", ")}]`);
  }

  if (spec.process) {
    lines.push("process:");
    if (spec.process.noNewPrivileges !== undefined) {
      lines.push(`  no_new_privileges: ${spec.process.noNewPrivileges}`);
    }
    if (spec.process.dropCaps) {
      lines.push(`  drop_caps: ${spec.process.dropCaps}`);
    }
  }

  if (spec.inference) {
    lines.push("inference:");
    lines.push(`  endpoint: ${yamlString(spec.inference.endpoint)}`);
    if (spec.inference.provider) lines.push(`  provider: ${yamlString(spec.inference.provider)}`);
    if (spec.inference.model) lines.push(`  model: ${yamlString(spec.inference.model)}`);
  }

  return lines.join("\n") + "\n";
}

/** Read-only egress: inference + given API hosts (GET only). No push. */
export function reviewReadonlyPolicy(input: {
  inferenceHost: string;
  apiHosts?: string[];
}): RuntimePolicySpec {
  return {
    network: {
      default: "deny",
      allow: [
        { host: input.inferenceHost },
        ...(input.apiHosts ?? []).map((host) => ({ host, methods: ["GET"] })),
      ],
    },
    filesystem: { allowWrite: ["/sandbox"] },
    process: { noNewPrivileges: true },
  };
}

/** Coding: package registries + inference; git egress stays blocked (push is host-side). */
export function codingRegistriesPolicy(input: {
  inferenceHost: string;
  registryHosts?: string[];
}): RuntimePolicySpec {
  const registries = input.registryHosts ?? [
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
  ];
  return {
    network: {
      default: "deny",
      allow: [{ host: input.inferenceHost }, ...registries.map((host) => ({ host }))],
    },
    filesystem: { allowWrite: ["/sandbox"] },
    process: { noNewPrivileges: true },
  };
}

/** Strict deny-by-default: inference endpoint only. */
export function denyStrictPolicy(input: { inferenceHost: string }): RuntimePolicySpec {
  return {
    network: { default: "deny", allow: [{ host: input.inferenceHost }] },
    filesystem: { allowWrite: ["/sandbox"] },
    process: { noNewPrivileges: true, dropCaps: "all" },
  };
}
