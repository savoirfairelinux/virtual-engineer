# Virtual Engineer Code Quality Audit

**Date:** 2026-08-14
**Scope:** TypeScript orchestrator, state store, OpenShell runtime, agent worker, polling loop, Docker image, and related tests.

## Executive Summary

The codebase has a strong overall shape: provider execution is descriptor-driven, host-side Git and OpenShell command handling already contain useful isolation and output limits, and the state layer has thoughtful comments around uniqueness and restart behavior. The most important remaining risks are at subsystem boundaries where identity, recovery state, or security policy is lost.

The audit found four high-priority issues:

1. External-change lookup can select a task from the wrong integration.
2. Restart reconciliation fails interrupted review-commenting tasks before review recovery can inspect them.
3. Runtime filesystem protection rejects only exact protected paths, allowing writable descendants of protected trees.
4. Worker-side Git commands do not apply the same repository hardening used by host-side Git.

The main optimization theme is bounded coordination: polling, subprocess output, event retention, and in-memory lifecycle maps should all have explicit ownership and limits.

## Implementation Status

The initial implementation pass addresses the first three high-priority findings:

- Integration-aware external-change lookups now fail closed without an exact `change_per_repository` match, and polling passes the already-selected task identity through to the orchestrator.
- `REVIEW_COMMENTING` remains available to the existing proof-based review recovery path after restart.
- Runtime filesystem protection now rejects protected descendants and traversal segments, while preserving legitimate writable paths such as `/sandbox`.

Regression coverage was added for shared change IDs, task-preserving review polling, restart reconciliation, and protected filesystem descendants. Full execution remains blocked in this environment by Node 20 instead of the project-required Node 22+, a Vitest bus error, and incomplete agent-worker dependencies.

## Findings

### High: External-change lookup is not integration-scoped

**Evidence:** [taskStore.ts](../src/state/stores/taskStore.ts#L1017) first selects the newest task matching `gerrit_change_id` without using the supplied `integrationId`. The integration filter is applied only to the fallback `change_per_repository` query at [taskStore.ts](../src/state/stores/taskStore.ts#L1029).

**Impact:** The same change identifier can exist on different Gerrit instances, GitLab projects, GitHub repositories, or review integrations. A webhook or review event can therefore be routed to the newest unrelated task, causing feedback processing, merge handling, or abandonment against the wrong project.

**Recommendation:** Make the primary lookup integration-aware. Prefer a persisted task-level integration identifier, or join through `change_per_repository`/the source label and require an exact integration match before returning a task. Add a regression test with two integrations sharing the same change ID.

### High: Interrupted review-commenting recovery is bypassed

**Evidence:** [taskStore.ts](../src/state/stores/taskStore.ts#L329) includes `REVIEW_COMMENTING` in `reconcileOrphanedActiveTasks()`. That method is called at boot from [index.ts](../src/index.ts#L69), before `recoverActiveReviews()` is registered at [index.ts](../src/index.ts#L475).

**Impact:** A process restart during review posting immediately changes `REVIEW_COMMENTING` to `REVIEW_FAILED`. The state-aware recovery path cannot determine whether comments, replies, votes, or summaries were partially posted. This can lose a recoverable review or leave remote side effects ambiguous.

**Recommendation:** Let review recovery own `REVIEW_COMMENTING`. Keep `AGENT_RUNNING` and `REVIEW_RUNNING` in orphan reconciliation, then have review recovery prove completion from the persisted cycle and `reviewedPatchset` before finalizing; otherwise fail explicitly with an operator-visible reason. Add restart tests for both proven-complete and partial-commenting cases.

### High: Filesystem policy floor allows protected descendants

**Evidence:** [runtimePolicyResolver.ts](../src/openshell/runtimePolicyResolver.ts#L39) defines protected trees, but [runtimePolicyResolver.ts](../src/openshell/runtimePolicyResolver.ts#L62) rejects only exact string matches after trimming trailing slashes.

**Impact:** Paths such as `/etc/ssh`, `/usr/local/bin`, `/app/config`, or normalized variants containing `.`/`..` can evade the floor while remaining inside trees that the comments describe as non-writable. The resulting policy could let an agent modify runtime configuration, executables, or credential-related files.

**Recommendation:** Normalize absolute POSIX paths and reject a path when it equals a protected path or has that path as a directory-boundary prefix. Reject non-absolute and traversal-containing entries. Keep the resolver as the final enforcement point and mirror the validation in the admin API. Extend [runtimePolicyResolver.test.ts](../tests/unit/runtimePolicyResolver.test.ts#L131) with descendants and normalization cases.

### High: Worker Git operations do not inherit repository hardening

**Evidence:** The worker defines a plain Git helper at [index.ts](../agent-worker/src/index.ts#L187) and commit utilities define another at [commitUtils.ts](../agent-worker/src/commitUtils.ts#L21). These invoke Git without the host-side trusted configuration/environment controls. Rebase and abort paths also invoke Git directly at [commitUtils.ts](../agent-worker/src/commitUtils.ts#L319).

**Impact:** Repository-controlled Git configuration, hooks, or attributes can execute during worker-side status, commit, and rebase processing. Agent credentials are available in the worker execution environment, so a malicious hook can turn repository processing into credential or data exfiltration within whatever network policy the sandbox permits.

**Recommendation:** Create one worker Git runner that pins global/system config, hooks, includes, and credential helpers to safe values, matching the host contract. Use it for every worker Git call, including cleanup and rebase paths. Add a test repository containing a hostile hook and repository config, and assert that no hook runs and no credential-bearing environment reaches it.

### High: Raw agent output is persisted and returned without a storage boundary

**Evidence:** [taskStore.ts](../src/state/stores/taskStore.ts#L479) stores the complete `AgentResult`, and [taskStore.ts](../src/state/stores/taskStore.ts#L481) stores raw `agentEvents` separately. The cycle API returns `cycle.result` directly at [adminTaskRoutes.ts](../src/admin/adminTaskRoutes.ts#L249). Sanitization is applied while formatting SSE events at [adminStreamRoutes.ts](../src/admin/adminStreamRoutes.ts#L235), not before database persistence or cycle serialization.

**Impact:** Provider errors, tool payloads, URLs, or accidental credential material can remain in SQLite and be exposed through the cycle endpoint. The current pattern list also does not guarantee coverage for every provider-specific token format. Retention and database access therefore become part of the secret-protection boundary.

**Recommendation:** Define a single redacted event/result representation at ingestion and persist only that representation. Keep full raw output out of the database unless explicitly opted into a protected diagnostic store with a retention limit. Minimize tool input/output capture, cap log sizes, and add tests for each supported credential format and for the cycle API response.

### Medium: Aider image installation is incompatible with the sandbox user

**Evidence:** [Dockerfile.agent](../Dockerfile.agent#L20) creates the unprivileged `sandbox` user, while [Dockerfile.agent](../Dockerfile.agent#L32) installs Aider under `/root/.local` and [Dockerfile.agent](../Dockerfile.agent#L33) symlinks `/usr/local/bin/aider` back into that root-owned tree.

**Impact:** OpenShell runs the agent as `sandbox`. On a normal image where `/root` is not traversable by that user, the Aider symlink resolves to an inaccessible binary and the Aider provider fails at runtime.

**Recommendation:** Install Aider into an accessible system-owned directory, or copy the resolved executable and required tool environment into `/usr/local`. Add an image smoke test that runs `aider --version` as `sandbox`.

### Medium: Polling cooldown keys are inconsistent and poll cycles can overlap

**Evidence:** Review assignment polling stores `${integrationId}:${changeId}` at [pollingLoop.ts](../src/orchestrator/pollingLoop.ts#L381), while in-review eviction compares those entries to raw change IDs at [pollingLoop.ts](../src/orchestrator/pollingLoop.ts#L417). The timer invokes `runTicketPollCycle()` through `setInterval()` at [pollingLoop.ts](../src/orchestrator/pollingLoop.ts#L164), with no in-flight guard in [pollingLoop.ts](../src/orchestrator/pollingLoop.ts#L190).

**Impact:** Assignment cooldown entries are evicted as soon as the in-review eviction runs, so assignment polling can repeat provider calls within the intended cooldown. If a provider call exceeds the interval, multiple complete poll cycles can run concurrently, increasing API load and duplicate trigger pressure.

**Recommendation:** Use separate typed cooldown maps for assignment discovery, code-generation review polling, and review watching, or namespace both insertion and eviction consistently. Track an active poll promise and skip/coalesce the next tick while one is running. Add tests for slow polls and shared change IDs.

### Medium: Provider subprocess cleanup and buffers are not uniformly bounded

**Evidence:** Provider cleanup calls `child.kill('SIGTERM')` directly, for example at [aider.ts](../agent-worker/src/providers/aider.ts#L300), rather than terminating the full process group. Output accumulators grow without a provider-local limit at [aider.ts](../agent-worker/src/providers/aider.ts#L332) and [aider.ts](../agent-worker/src/providers/aider.ts#L339), with the same pattern in Codex at [codex.ts](../agent-worker/src/providers/codex.ts#L346) and [codex.ts](../agent-worker/src/providers/codex.ts#L360).

**Impact:** A CLI descendant can survive a timeout and retain CPU, files, or credentials. Large model output or verbose diagnostics can consume worker memory even though the host OpenShell command runner caps its own retained output.

**Recommendation:** Introduce one worker subprocess helper that uses detached process groups, abort-aware termination with escalation, bounded stdout/stderr collectors, and bounded assistant-text retention. Preserve only a diagnostic tail after the limit is reached. Cover timeout and descendant cleanup with integration tests.

### Medium: Worker result writes can be truncated by immediate exit

**Evidence:** [agent-worker/src/index.ts](../agent-worker/src/index.ts#L615) and [agent-worker/src/index.ts](../agent-worker/src/index.ts#L629) call `process.stdout.write()` and then immediately call `process.exit(0)`.

**Impact:** For a large review or diagnostic result, the process can exit before stdout drains. The host then receives invalid or incomplete JSON and loses the cycle result.

**Recommendation:** Set `process.exitCode` and allow the event loop to drain, or await the stdout write callback before exiting. Add a test that emits a result larger than the pipe's writable high-water mark.

### Medium: State transitions used by review polling do not update `updated_at`

**Evidence:** The special polling transition branch at [taskStore.ts](../src/state/stores/taskStore.ts#L371) updates `state` but omits `updated_at`, unlike the normal transition branch.

**Impact:** `IN_REVIEW` and `FEEDBACK_PROCESSING` changes can appear stale to admin sorting, recovery heuristics, and any logic using update time for deduplication or activity reporting.

**Recommendation:** Update `updated_at` in every state transition, including the polling branch, and add a timestamp assertion to the state-store tests.

### Medium: Provider environment allowlists are inconsistent with gateway proxy requirements

**Evidence:** Gemini explicitly preserves proxy and CA variables at [gemini.ts](../agent-worker/src/providers/gemini.ts#L72), including `HTTP_PROXY` and `NODE_EXTRA_CA_CERTS`. Aider, Goose, Codex, OpenCode, and Cursor define separate allowlists without those variables, for example [aider.ts](../agent-worker/src/providers/aider.ts#L119) and [codex.ts](../agent-worker/src/providers/codex.ts#L58).

**Impact:** Providers can fail TLS validation or bypass the expected OpenShell gateway proxy depending on deployment environment. The behavior differs by provider even though they share the same sandbox contract.

**Recommendation:** Build all provider subprocess environments from one shared base allowlist containing the required proxy and CA variables, then append provider-specific credentials and settings. Test the generated environment for every provider.

## Optimization Opportunities

These are lower-risk improvements that should follow the correctness and isolation fixes above.

1. **Batch project polling lookups.** `pollProjectTickets()` performs project and ticket state reads serially. Add store methods that fetch active/latest task state for a set of ticket IDs, then use bounded concurrency per project. This reduces SQLite round trips and shortens the interval during which duplicate webhook/poll work can race.
2. **Narrow the concurrency lease.** The orchestrator acquires the agent lease before ticket resolution, repository preparation, and workspace setup. If host workspace preparation is allowed to run in parallel, acquire the lease immediately before agent execution so slow clones do not consume scarce provider capacity.
3. **Centralize bounded retention.** Apply one limit policy to worker output, persisted `agentLogs`, structured events, and live buffers. Keep metrics and a diagnostic tail, while dropping verbose token deltas and repeated stderr lines after a threshold.
4. **Bound lifecycle metadata.** `deletedTaskIds` in [taskLifecycleCoordinator.ts](../src/orchestrator/taskLifecycleCoordinator.ts#L11) grows for the lifetime of the process. Replace it with a bounded tombstone cache or a database-backed task existence check if task deletion markers are needed after cleanup.
5. **Make image builds reproducible.** Codex and Gemini are installed without versions, and the Cursor installer is intentionally floating in [Dockerfile.agent](../Dockerfile.agent#L82). Pin package versions or verify immutable release artifacts in CI, with provider CLI smoke tests.

## Positive Design Signals

- Host-side OpenShell command execution already uses detached process groups, SIGTERM/SIGKILL escalation, and a 32 MiB retained-output cap in [openShellClient.ts](../src/openshell/openShellClient.ts#L65).
- The state store uses explicit active-task uniqueness handling and documents why recovery must select active rows rather than merely newest rows.
- Runtime policy tests cover exact protected paths and trailing slash normalization; the missing case is descendant/boundary matching.
- Provider adapters are largely descriptor-driven, reducing central branching as new agent backends are added.
- The admin route surface uses explicit PBAC permissions, which makes the raw-cycle exposure a clear, localized contract to tighten.

## Quality-Gate Results

| Check | Result | Notes |
|---|---|---|
| `npm test -- --reporter=dot` | Blocked | Host filesystem is full: `ENOSPC` while npm attempted to write its log. |
| `npm run typecheck` | Blocked | Same `ENOSPC` condition before TypeScript ran. |
| `npm run lint` | Blocked | Same `ENOSPC` condition before ESLint ran. |
| Direct `vitest`, `tsc`, and `eslint` invocations | Unavailable | The expected `node_modules/.bin` executables are absent from the incomplete local install. |
| `git diff --check` | Passed | No whitespace errors reported. |

The worktree already contained an unrelated modification deleting `tests/unit/startScript.test.ts` (616 lines). It was not changed by this audit.

## Recommended Remediation Order

1. Fix integration-scoped external-change routing and review-commenting restart recovery.
2. Close the filesystem-policy descendant gap and apply hardened Git execution inside the worker.
3. Redact and bound agent output before persistence; fix the Aider image path.
4. Centralize worker subprocess lifecycle, output limits, and provider environment construction.
5. Add the polling in-flight guard, correct cooldown namespaces, and update transition timestamps.
6. Apply batching, lease-scope, retention, and build reproducibility optimizations.

After freeing disk space and restoring dependencies, rerun `npm test`, `npm run typecheck`, and `npm run lint`; the first four items should each have a focused regression test before being considered closed.