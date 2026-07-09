/**
 * Runtime micro-benchmark — measures the overhead VE adds around agent
 * execution: runtime resolution + policy YAML generation. This does NOT
 * benchmark real sandbox startup (that requires a live OpenShell gateway /
 * Docker daemon); it establishes that VE's own dispatch overhead is negligible
 * relative to container/sandbox startup, and serves as a regression guard.
 *
 * Run: npx tsx scripts/benchmark-runtime.ts
 */

import { RuntimeRegistry } from "../src/runtime/runtimeRegistry.js";
import type { WorkspaceRunner } from "../src/interfaces.js";
import {
  buildPolicyYaml,
  reviewReadonlyPolicy,
  codingRegistriesPolicy,
  denyStrictPolicy,
} from "../src/openshell/openShellPolicyBuilder.js";

function bench(label: string, iterations: number, fn: () => void): void {
  // Warm up.
  for (let i = 0; i < 1000; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const perOpUs = elapsedNs / iterations / 1000;
  console.log(`${label.padEnd(34)} ${perOpUs.toFixed(3)} µs/op  (${iterations.toLocaleString()} ops)`);
}

function main(): void {
  const noop = {} as unknown as WorkspaceRunner;
  const registry = new RuntimeRegistry().register("docker", noop).register("openshell", noop);

  console.log("Virtual Engineer — runtime dispatch micro-benchmark\n");

  bench("registry.resolve (default)", 1_000_000, () => registry.resolve());
  bench("registry.resolve (project override)", 1_000_000, () => registry.resolve({ project: "openshell" }));
  bench("policy: review-readonly", 200_000, () =>
    buildPolicyYaml(reviewReadonlyPolicy({ inferenceHost: "api.anthropic.com", apiHosts: ["api.github.com"] }))
  );
  bench("policy: coding-registries", 200_000, () =>
    buildPolicyYaml(codingRegistriesPolicy({ inferenceHost: "api.openai.com" }))
  );
  bench("policy: deny-strict", 200_000, () =>
    buildPolicyYaml(denyStrictPolicy({ inferenceHost: "inference.local" }))
  );

  console.log("\nNote: real sandbox startup (docker run / openshell sandbox create) dominates");
  console.log("end-to-end latency; benchmark that against a live backend before flipping the");
  console.log("default runtime (see docs/adr/0001-openshell-agent-runtime.md acceptance criteria).");
}

main();
