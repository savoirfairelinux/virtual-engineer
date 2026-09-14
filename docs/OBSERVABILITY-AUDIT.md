# Virtual Engineer — Observability Surface Audit

**Scope:** capability audit of what this system *can* measure. No database was opened; no
metric values appear here. Source code is the authority; divergences from `docs/ARCHITECTURE.md`
are flagged inline.

**Method:** static read of `src/state/schema.ts`, `src/state/stateMachine.ts`,
`src/state/stores/*`, `src/agents/*`, `src/admin/*`, `src/openshell/*`, `src/orchestrator/*`,
`src/review/*`, `src/workspace/*`, `src/logger.ts`, and `agent-worker/src/**`. Every claim
below carries a file (and, where the claim is non-obvious, a line) citation. Where I could not
confirm a signal exists, I say so explicitly rather than assuming.

**Vocabulary used throughout:** `TaskState` (`src/domain/tasks.ts` via `src/interfaces.ts`),
`TaskType` (`code-gen` | `code-review`), `DomainCapability` (`issue_tracking` | `code_review` |
`source_control` | `agent_execution`), `ProviderId` (the 13 providers in `src/state/schema.ts`
`integrations.provider`).

---

## 0. Documentation divergences found

| Claim | Reality | File |
|---|---|---|
| `docs/ARCHITECTURE.md` §3.4 route-module table lists 14 modules | The router registers **18** admin route modules. Missing from the table: `adminAuditRoutes.ts` (`GET /api/admin/audit` — the entire audit-trail read surface), `adminAuthRoutes.ts`, `adminPoliciesRoutes.ts`, `adminProjectVendorComponentsRoutes.ts`, `adminProjectWorkspaceRoutes.ts` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#L323), [src/admin/adminAuditRoutes.ts](src/admin/adminAuditRoutes.ts#L40) |
| §3.4 lists `adminOverviewRoutes.ts` as "overview aggregates + cost summary" | It also serves `GET /api/admin/model-usage`, a third distinct aggregate | [src/admin/adminOverviewRoutes.ts](src/admin/adminOverviewRoutes.ts#L153) |
| `docs/ARCHITECTURE.md` §6 core-table listing | **Accurate.** `agent_cycles` cost columns and both review dedup ledgers match `schema.ts` | [src/state/schema.ts](src/state/schema.ts#L79) |
| No doc claims a metrics/tracing surface | Correct — there is none. `docs/adr/0001-openshell-agent-runtime.md#L276` mentions observability only as an aspirational acceptance criterion for the runtime | [docs/adr/0001-openshell-agent-runtime.md](docs/adr/0001-openshell-agent-runtime.md#L276) |

No doc asserts an observability capability that the code lacks. The gap is that the docs are
silent on the subject, not wrong about it.

---

## Phase 1 — Inventory

### Axis definitions

- **CAPTURED** — the raw signal is produced somewhere in the process.
- **DURABLE** — survives a restart (SQLite), vs. in-memory/log-only.
- **EXPOSED** — reachable via an HTTP route *and/or* rendered in the admin SPA, vs. reachable
  only by hand-written SQL against the DB or by grepping logs.

`JSON` in the EXPOSED column means the value is returned inside an opaque JSON blob
(`agent_cycles.agent_result` / `.agent_events` / `state_transitions.metadata`) — technically
reachable, but not queryable, aggregatable, or indexable without `json_extract` gymnastics.

### 1.1 Task lifecycle

| Signal | Captured | Durable | Exposed | Where |
|---|---|---|---|---|
| Task state (current) | yes | `tasks.state` | `GET /api/admin/tasks`, `/tasks/:id`, SSE `/api/admin/events/stream` (5 s poll) | [schema.ts#L15](src/state/schema.ts#L15), [adminTaskRoutes.ts#L57](src/admin/adminTaskRoutes.ts#L57), [adminStreamRoutes.ts#L165](src/admin/adminStreamRoutes.ts#L165) |
| Task type (`code-gen`/`code-review`) | yes | `tasks.task_type` | yes | [schema.ts#L21](src/state/schema.ts#L21) |
| Every state transition + timestamp | yes | `state_transitions` | `GET /api/admin/tasks/:id/transitions` (per-task only; no aggregate route) | [taskStore.ts#L347](src/state/stores/taskStore.ts#L347) |
| Transition *reason* | **partial** | `state_transitions.metadata` JSON | JSON | Only 7 call sites write anything: `{reason:"waiting for available agent slot"}`, `{error, cancelled}`, `{error}`, `{reviewMode:true}`, `{}`. See [orchestrator.ts#L722](src/orchestrator/orchestrator.ts#L722), [#L876](src/orchestrator/orchestrator.ts#L876), [#L945](src/orchestrator/orchestrator.ts#L945), [reviewOrchestrator.ts#L499](src/review/reviewOrchestrator.ts#L499), [#L1085](src/review/reviewOrchestrator.ts#L1085) |
| Cycle count | yes | `tasks.cycle_count` | yes | [schema.ts#L29](src/state/schema.ts#L29) |
| Failure reason | yes (free text) | `tasks.failure_reason` | yes | [schema.ts#L30](src/state/schema.ts#L30) — **unclassified string**, no taxonomy code |
| Pause / resume | yes | `state_transitions` row with `from_state == to_state`, `metadata.action` | via transitions route (JSON) | [taskStore.ts#L660](src/state/stores/taskStore.ts#L660) |
| Patchset progression (`current_patchset`, `reviewed_patchset`) | yes | `tasks` | yes | [schema.ts#L26](src/state/schema.ts#L26) |
| Per-repo change status (`OPEN`/`MERGED`/`ABANDONED`/`ORPHANED`/`NO_CHANGE`) | yes | `change_per_repository.status` | `GET /api/admin/tasks/:id` → `changesPerRepo[]` | [schema.ts#L237](src/state/schema.ts#L237), [adminTaskRoutes.ts#L77](src/admin/adminTaskRoutes.ts#L77) |
| Task→project→agent binding at *query* time | yes | `tasks.project_id` → `projects.agent_id` | yes | mutable — see §1.7 Q3 |

### 1.2 Agent cycle

| Signal | Captured | Durable | Exposed | Where |
|---|---|---|---|---|
| Cycle row + `created_at` | yes | `agent_cycles` | `GET /api/admin/tasks/:id/cycles` | [taskStore.ts#L493](src/state/stores/taskStore.ts#L493) |
| Cycle outcome (`success`/`no_change`/`failed`/`running`) | yes | inside `agent_result` JSON | JSON | [interfaces.ts#L512](src/interfaces.ts#L512) |
| Modified file list / count | yes | `agent_result` JSON | JSON | [agentEventTypes.ts#L50](src/agents/agentEventTypes.ts#L50) |
| Commits created (sha, subject, files, Change-Id) | yes | `agent_result.commits` JSON | JSON | [interfaces.ts#L498](src/interfaces.ts#L498) |
| **Engine (adapter) that ran the cycle** | **code-gen only** | `agent_result.metadata.adapter` JSON | JSON | [agent-worker/src/index.ts#L616](agent-worker/src/index.ts#L616) normalizes it onto every code-gen result. **Review cycles lose it** — see §1.7 Q3 |
| Model that ran the cycle | yes | `agent_cycles.cost_model_id` **and** `metadata.model` | column + JSON | [taskStore.ts#L480](src/state/stores/taskStore.ts#L480) |
| Cost: AI credits / USD / premium requests | **provider-dependent** | `cost_ai_credits`, `cost_usd`, `premium_requests` | `GET /api/admin/cost-summary`, Overview SPA | [cycleCost.ts#L57](src/agents/cycleCost.ts#L57), [costStore.ts#L28](src/state/stores/costStore.ts#L28) |
| Tokens in / out / cache-read / cache-write | **provider-dependent** | 4 `cost_*_tokens` columns | `GET /api/admin/cost-summary` (`totalTokens`, `perProject[].tokens`) and `GET /api/admin/model-usage` (`totalTokens`, `byModel[].tokens`), rendered in the Overview SPA | [costStore.ts](src/state/stores/costStore.ts). `runCountWithTokens` distinguishes a genuine zero from an engine that reports no usage at all |
| Cycle duration | **derived, lossy** | not stored | `GET /tasks/:id/cycles` → `durationMs` | Computed as `lastEvent.timestamp − cycle.createdAt` at serialize time: [adminTaskRoutes.ts#L248](src/admin/adminTaskRoutes.ts#L248). Returns `null` when `agent_events` is empty or the last event precedes `createdAt` |
| Validation result (`status`, `testOutput`, `lintOutput`, `durationMs`) | schema exists | `agent_cycles.validation_result` | JSON | [interfaces.ts#L592](src/interfaces.ts#L592). **I found no production writer** — `saveAgentCycle`'s `validationResult` parameter is optional and the orchestrator never passes it ([orchestrator.ts#L871-L940](src/orchestrator/orchestrator.ts#L871)). Treat as dead capacity unless a caller exists that I did not find |
| Review cycle: comment count, reply count, vote/score | yes | `agent_result.metadata` JSON | JSON; `score` is scraped by the overview | [reviewOrchestrator.ts#L1028](src/review/reviewOrchestrator.ts#L1028), [adminOverviewRoutes.ts#L61](src/admin/adminOverviewRoutes.ts#L61) |
| Review supersession (`superseded: true`) | yes | `agent_result.metadata` JSON | JSON | [reviewOrchestrator.ts#L854](src/review/reviewOrchestrator.ts#L854), [#L882](src/review/reviewOrchestrator.ts#L882) |
| Dedup-suppressed comment count (`dedupedCount`) | yes | `agent_events` JSON (`review.posting_comments`, `review.completed`) | JSON | [reviewOrchestrator.ts#L939](src/review/reviewOrchestrator.ts#L939) — **not** in the cycle metadata block, only in the event stream |

### 1.3 Agent event stream (`agent_events` JSON + SSE)

Taxonomy (from `buildEventMessage`, [agentEventTypes.ts#L418](src/agents/agentEventTypes.ts#L418)):
`stderr.line`, `tool.execution_start`, `tool.execution_complete`, `tool.execution_progress`,
`assistant.message`, `assistant.streaming_delta`, `assistant.usage`, `session.usage_info`,
`session.start`, `session.end`, `session.error`, `permission.requested`, `permission.denied`,
`permission.approved`, `skills.fetch_{start,complete,failed}`, `review.{started,prompt_built,
agent_started,agent_completed,parsing,posting_comments,completed,failed}`, plus
`commit.validation_failed` and `review.{closed,superseded,native_delegation_failed}` emitted but
not given a display message.

| Signal | Captured | Durable | Exposed | Where |
|---|---|---|---|---|
| Full event array per cycle | yes | `agent_cycles.agent_events` TEXT | replayed on SSE connect | [taskStore.ts#L476](src/state/stores/taskStore.ts#L476), [adminStreamRoutes.ts#L24](src/admin/adminStreamRoutes.ts#L24) |
| Live stream during a run | yes | **no** — `EventEmitter` + 500-event ring per task | SSE `/api/admin/logs/stream` | [agentEventBus.ts#L20](src/agents/agentEventBus.ts#L20) |
| Tool call count / per-tool counts | yes | `session.end` data (`toolCallCount`, `toolsByKind`) + derived `SessionMetrics` | JSON / SPA only | [copilot.ts#L606](agent-worker/src/providers/copilot.ts#L606), [agentEventTypes.ts#L110](src/agents/agentEventTypes.ts#L110) |
| **Per-tool-call duration** | **Copilot only** | `tool.execution_complete.durationMs` in `agent_events` | JSON / SPA | [copilot.ts#L460](agent-worker/src/providers/copilot.ts#L460). Aider/Claude/Codex/Cursor/Gemini/Goose/OpenCode emit start+complete with no measured delta |
| Permission denials (agent-side) | yes | `permission.denied` events | JSON / SPA "Tool usage" | [agentEventTypes.ts#L118](src/agents/agentEventTypes.ts#L118) (`totalDenials`, `denialCount`) |
| Secret redaction before exposure | yes | n/a | n/a | [agentEventTypes.ts#L146](src/agents/agentEventTypes.ts#L146) — 7 regex patterns + secret-key masking |

### 1.4 Security / policy

| Signal | Captured | Durable | Exposed | Where |
|---|---|---|---|---|
| Sandbox policy denial (runtime, category, host, method, path, reason) | yes | `policy_denial_events` | `GET /api/admin/runtime/denials`, SPA `DenialsSection` | [denialEvents.ts#L100](src/openshell/denialEvents.ts#L100), [schema.ts#L522](src/state/schema.ts#L522), [adminDenialRoutes.ts#L11](src/admin/adminDenialRoutes.ts#L11) |
| Denial → task / project attribution | yes | `task_id`, `project_id` columns | yes (filterable) | [denialStore.ts#L6](src/state/stores/denialStore.ts#L6) |
| Denial → **cycle** attribution | **no** | — | — | `DenialContext` carries only `taskId`/`projectId` ([denialEvents.ts#L21](src/openshell/denialEvents.ts#L21)); no `cycle_number` column in `policy_denial_events` ([schema.ts#L522](src/state/schema.ts#L522)) |
| Denial secret scrubbing | yes | n/a | n/a | [denialEvents.ts#L37](src/openshell/denialEvents.ts#L37) |
| Admin mutation audit trail (actor, action, target, masked details) | yes | `audit_log` (append-only, 3 indexes) | `GET /api/admin/audit`, SPA `AuditSection` | [adminAudit.ts#L147](src/admin/adminAudit.ts#L147), [schema.ts#L595](src/state/schema.ts#L595) |
| Audit append failures | yes | **log only** | `log.error` after 4 attempts | [adminAudit.ts#L137](src/admin/adminAudit.ts#L137) |
| Managed credential-provider ownership | yes | `managed_openshell_providers` | **no route** | [schema.ts#L545](src/state/schema.ts#L545) |
| Login rate-limiting / auth failures | not audited as events | — | — | I checked `adminAuthRoutes.ts` route registrations; no `recordAudit` on failed login was found |

### 1.5 Saturation / runtime

| Signal | Captured | Durable | Exposed | Where |
|---|---|---|---|---|
| Active run slots (global / per-project / per-integration) | yes | **in-memory only**, resets on restart | `GET /api/admin/concurrency` — **not consumed by the SPA** | [concurrencyTracker.ts#L141](src/orchestrator/concurrencyTracker.ts#L141), [adminConcurrencyRoutes.ts#L13](src/admin/adminConcurrencyRoutes.ts#L13) |
| Queue depth (`pendingAcquisitions`) | in-memory | no | **not in `snapshot()`** | `ConcurrencySnapshot` has only `global`/`perProject`/`perAgent` ([concurrencyTracker.ts#L44](src/orchestrator/concurrencyTracker.ts#L44)) |
| Wait time for a slot | **not measured** | — | — | `acquireWhenAvailable` records no start timestamp ([concurrencyTracker.ts](src/orchestrator/concurrencyTracker.ts)) |
| Capacity rejection | yes | `state_transitions` `AGENT_RUNNING → RETRY_CYCLE` with `{reason:"waiting for available agent slot"}` | JSON | [orchestrator.ts#L695](src/orchestrator/orchestrator.ts#L695) |
| Polling backoff (`ticketFailureCount`, `ticketBackoffUntil`) | yes | **in-memory** | **no** — `GET /api/admin/status` returns only `running` + configured `intervalMs` | [pollingLoop.ts#L189](src/orchestrator/pollingLoop.ts#L189), [adminServer.ts#L365](src/admin/adminServer.ts#L365) |
| Sandbox reconciler results (`scanned`/`deleted`/`failed`/`skipped*`) | yes | **log only**; periodic run discards the return value | no route | [openShellSandboxReconciler.ts#L51](src/openshell/openShellSandboxReconciler.ts#L51), [#L152](src/openshell/openShellSandboxReconciler.ts#L152) |
| Liveness / readiness | yes | n/a | `GET /health` (static ok), `GET /ready` (gateway health) | [adminServer.ts#L587](src/admin/adminServer.ts#L587) |
| Process uptime, DB file size | yes | n/a | `GET /api/admin/overview` → `runtime`, pre-formatted strings | [adminOverviewRoutes.ts#L110](src/admin/adminOverviewRoutes.ts#L110) |

### 1.6 Logs

`src/logger.ts` is a thin Pino factory: one root logger with `base:{pid}`, child per component,
`level = LOG_LEVEL ?? (test ? silent : info)`, `pino-pretty` transport outside production
([logger.ts#L13](src/logger.ts#L13)). Consequences:

- **No `taskId` binding at the logger level.** Every call site must pass `taskId` manually in
  the object argument. Most do, some don't — e.g. `runtimeStartup.ts` logs a fieldless warning
  ([runtimeStartup.ts#L27](src/runtime/runtimeStartup.ts#L27)); `openShellClient.ts` logs
  `{args, code, stderr}` with no task correlation ([openShellClient.ts#L390](src/openshell/openShellClient.ts#L390)).
- No log sink, no retention policy, no structured field schema, no correlation id.
- Pretty-printing is on for `NODE_ENV !== production`, which is the default — so the default
  dev deployment emits non-JSON logs that no collector can parse.

Structured field vocabulary in the hot paths (union of observed keys):
`taskId`, `cycleNumber`/`cycle`, `projectId`, `agentId`, `integrationId`, `changeId`, `repoKey`,
`ticketId`, `state`, `patchset`/`oldPatchset`/`newPatchset`, `err`, `count`, `source`,
`backoffUntil`, `sandbox`, `phase`, `provider`, `attempt`.

### 1.7 Answers to the specific questions

**Q1 — Metrics endpoint / tracing / span propagation?**
**None of the three.** `prom-client`, `statsd`, and any `@opentelemetry/*` runtime package are
absent from `src/` and `agent-worker/src/`; the only `@opentelemetry/api` hits are transitive
entries in `package-lock.json` (a peer dependency of a vendored SDK), never imported by this
codebase. There is no `/metrics` route — the full route inventory is the 112 `router.add(...)`
registrations across `src/admin/*.ts` plus `/health`, `/ready`, `/admin`, the img-proxy, and the
webhook receiver. No trace id, span id, or correlation id is generated anywhere. The only
identity crossing the host→sandbox boundary is `TASK_ID` (code-gen only) plus optional
`ROOT_CHANGE_ID`, `PER_REPO_CHANGE_IDS_JSON`, `REPOSITORY_MAP_JSON`
([containerSpecBuilders.ts#L44](src/agents/containerSpecBuilders.ts#L44)). **The review
container spec passes no task identity at all** — only provider env, `REVIEW_MODE`,
`REVIEW_STRATEGY`, and the system prompt ([containerSpecBuilders.ts#L76](src/agents/containerSpecBuilders.ts#L76)).
`CYCLE_NUMBER` is never injected into either; the host re-attaches `taskId`/`cycleNumber` to
inbound events on its own side ([agentStderrPipeline.ts#L40](src/agents/agentStderrPipeline.ts#L40)).

**Q2 — Are timings recorded, or only derivable from `state_transitions`?**
Almost entirely the latter, and the derivation is coarser than it looks:

- The **only** measured elapsed duration in the entire system is Copilot's per-tool-call
  `durationMs` ([copilot.ts#L460](agent-worker/src/providers/copilot.ts#L460)). It survives to
  `agent_cycles.agent_events` and is re-aggregated in the UI reducer
  ([agentEventTypes.ts#L750](src/agents/agentEventTypes.ts#L750)).
- Cycle duration is *reconstructed* at serialize time from event timestamps, not stored
  ([adminTaskRoutes.ts#L251](src/admin/adminTaskRoutes.ts#L251)), and is `null` for any cycle
  with no events (every non-Copilot failure path, every pre-events row).
- Every other `Date.now()` in the host is a **deadline, cooldown, retry delay, or age check** —
  polling backoff ([pollingLoop.ts#L189](src/orchestrator/pollingLoop.ts#L189)), review-trigger
  cooldowns ([pollingLoop.ts#L377](src/orchestrator/pollingLoop.ts#L377)), sandbox age
  ([openShellSandboxReconciler.ts#L84](src/openshell/openShellSandboxReconciler.ts#L84)), CLI
  command timeout ([openShellClient.ts#L362](src/openshell/openShellClient.ts#L362)), the
  one-hour review deadline ([reviewOrchestrator.ts#L536](src/review/reviewOrchestrator.ts#L536)).
  None computes or stores a start→end delta.
- **Critical limitation on the fallback:** `state_transitions.created_at` is
  `Math.floor(now/1000)` — **one-second resolution**
  ([taskStore.ts#L385](src/state/stores/taskStore.ts#L385)). Any phase shorter than ~1 s is
  unmeasurable by subtraction, and two transitions in the same second are indistinguishable in
  order except by the autoincrement `id`.
- Worse, most host work happens *inside* `AGENT_RUNNING` with no transition markers. Clone,
  skill install, sandbox create, upload, exec, download, restore, push all occur between the
  `→ AGENT_RUNNING` and `→ IN_REVIEW` rows. Subtraction gives you one opaque number.

**Q3 — Is the engine that produced an outcome recoverable historically?**
**Code-gen: yes, but only from JSON.** The worker stamps
`metadata: { adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL }` onto every result and
re-normalizes it in a `finally` block ([agent-worker/src/index.ts#L616](agent-worker/src/index.ts#L616)),
so `agent_cycles.agent_result` preserves the engine even after the project's agent binding is
edited. It is not a column, so it cannot be grouped or indexed.

**Review: no.** The worker *does* produce `metadata.adapter` for review runs
([agent-worker/src/index.ts#L338](agent-worker/src/index.ts#L338)), but it never reaches the
host's persistence path. `decodeReviewWorkerOutput` validates the envelope and returns **only**
`rawOutput: string` ([agentWorkerProtocol.ts#L14](src/workspace/agentWorkerProtocol.ts#L14)),
and `runReviewInDocker`'s contract is correspondingly `Promise<{ rawOutput: string }>`
([interfaces.ts#L717](src/interfaces.ts#L717)) — so the metadata is dropped at the **workspace
boundary**, not at the cycle write. The orchestrator then builds its own cycle result from
host-side values only: `{reviewMode, patchset, commentCount, replyCount, vote, comments, score}`
([reviewOrchestrator.ts#L1028](src/review/reviewOrchestrator.ts#L1028)). The engine is
recoverable for review cycles only indirectly and incompletely — `session.start` in
`agent_events` carries `{model, mode, workingDirectory}` but **not** the adapter label
([copilot.ts#L567](agent-worker/src/providers/copilot.ts#L567) and the equivalent line in each
of the other seven providers). Model-only inference back to an engine is ambiguous: Aider,
Goose, OpenCode, and Claude can all report the same Anthropic model id.

So: **cross-engine comparison of review quality is not possible from history today.** Engine
attribution for code-gen degrades to a `json_extract` scan.

**Q4 — Do cost columns populate for every provider? Where does the asymmetry come from?**
Three distinct tiers, and the asymmetry is structural, originating in
`computeCycleCost` ([cycleCost.ts#L57](src/agents/cycleCost.ts#L57)) which reads **only**
`assistant.usage` events:

| Tier | Providers | `cost_usd` | `cost_ai_credits` | tokens | Root cause |
|---|---|---|---|---|---|
| Priced (AIU) | **copilot** | authoritative | populated | populated | Only Copilot emits `totalNanoAiu` — extracted at [copilot.ts#L520](agent-worker/src/providers/copilot.ts#L520) and converted at 1 AIU = 1 credit = $0.01 ([cycleCost.ts#L6](src/agents/cycleCost.ts#L6)) |
| Token-only | claude, aider, codex, gemini, goose, opencode | **null** (or a *fabricated estimate*, see below) | null | populated | These emit `assistant.usage` without `totalNanoAiu`: [claude.ts#L230](agent-worker/src/providers/claude.ts#L230), [aider.ts#L476](agent-worker/src/providers/aider.ts#L476), [codex.ts#L209](agent-worker/src/providers/codex.ts#L209), [gemini.ts#L267](agent-worker/src/providers/gemini.ts#L267), [goose.ts#L562](agent-worker/src/providers/goose.ts#L562), [opencode.ts#L281](agent-worker/src/providers/opencode.ts#L281) |
| Blind | **cursor** | null | null | **null** | Cursor's terminal `result` event has no token/cost field at all, so no `assistant.usage` is ever emitted ([cursor.ts#L45](agent-worker/src/providers/cursor.ts#L45)) |

Two sharp edges follow:

1. **`GET /api/admin/cost-summary` is only meaningful for Copilot projects.** It `SUM`s
   `COALESCE(cost_usd, 0)` across all cycles ([costStore.ts](src/state/stores/costStore.ts)).
   A Claude-heavy and a Cursor-heavy project both contribute a zero USD term. (Since A1 the
   *token* side carries `runCountWithTokens`, so a Cursor project is now distinguishable from
   an idle one on tokens — but the USD column still has no provenance discriminator; see §3.5.)
2. **The USD fallback silently mixes measured and estimated money.** When `totalNanoAiu` is
   absent but the premium-request multiplier is present, `usd = premiumRequests × $0.04`
   ([cycleCost.ts#L112](src/agents/cycleCost.ts#L112)). That estimate lands in the same
   `cost_usd` column as GitHub-computed cost, with no discriminator. `cost_ai_credits IS NULL`
   is the *de facto* "this is an estimate" marker and is nowhere documented as such at the API
   layer — `CostSummaryProject` exposes `usd`, `aiCredits`, `premiumRequests`, `runCount` with
   no provenance field ([interfaces.ts](src/interfaces.ts)).

**Q5 — Are in-memory counters observable from outside the process?**
Barely. One of five is reachable:

| Counter | Route | SPA |
|---|---|---|
| Concurrency `snapshot()` (global/perProject/perAgent) | `GET /api/admin/concurrency` | **no** — grep over `src/admin/ui/**` finds no caller |
| Concurrency pending-queue depth | **no** | no |
| Polling `ticketFailureCount` / `ticketBackoffUntil` | **no** — `/api/admin/status` exposes `running` + configured interval only | no |
| Reconciler scanned/deleted/failed/skipped | **no** (startup run logged; periodic run's return value discarded) | no |
| OpenShell per-command `capturedBytes` / output-limit state | **no** | no |

All five reset to zero on restart. After a crash there is no record that the process was ever
saturated, ever backed off, or ever leaked a sandbox.

### 1.8 Captured but NOT exposed — the cheap wins

Ordered by how little work stands between the data and a consumer.

1. ~~**Token columns.**~~ **DONE (A1).** The four `cost_*_tokens` columns are now aggregated by
   both `getCostSummary` and `getModelUsageSummary` and exposed as `tokens` / `totalTokens`,
   alongside `runCountWithTokens` so a reported zero is distinguishable from an unreported one.
2. **Concurrency snapshot in the UI.** Route exists, permission exists (`concurrency.read`),
   nothing renders it.
3. **`agent_result.metadata.adapter`** — the engine label is already in every code-gen row.
   A `json_extract` in `getModelUsageSummary`'s `GROUP BY` would give per-engine breakdown
   immediately. *Backfillable for code-gen; not for review.*
4. **`dedupedCount`** — the review duplicate-suppression count is emitted on
   `review.posting_comments` and `review.completed` events
   ([reviewOrchestrator.ts#L939](src/review/reviewOrchestrator.ts#L939)) but is absent from the
   cycle `metadata` block, so it is only reachable by scanning the events array.
   *Backfillable from `agent_events`.*
5. **`posted_review_comments` and `review_thread_replies`.** Two fully-populated ledgers
   ([schema.ts#L133](src/state/schema.ts#L133), [#L177](src/state/schema.ts#L177)) with
   `severity`, `file`, `line`, `provider_thread_id`, `resolved` — and **no read route at all**.
   Every review-quality question needs SQL today.
6. **`change_per_repository.status`** — per-repo merge/abandon outcome is returned only inside
   `GET /api/admin/tasks/:id`; there is no aggregate ("what fraction of pushed changes merged").
7. **`state_transitions`** — per-task route only. No aggregate route means funnel/throughput
   analysis needs SQL.
8. **Reconciler results** — already computed as a typed struct
   ([openShellSandboxReconciler.ts#L16](src/openshell/openShellSandboxReconciler.ts#L16)), just
   thrown away by the interval callback ([#L152](src/openshell/openShellSandboxReconciler.ts#L152)).
9. **`managed_openshell_providers`** — a leak ledger with no read surface.
10. **`processed_comments`** — feedback-ingestion volume, no read surface.

### 1.9 Signals actively lost

- **Live agent events after a cycle ends.** `clearTaskEventBuffer` drops the ring buffer
  ([orchestrator.ts#L862](src/orchestrator/orchestrator.ts#L862)) — acceptable, since the array
  is persisted. But the buffer caps at 500 events ([agentEventBus.ts#L20](src/agents/agentEventBus.ts#L20)),
  so a reconnecting SSE client mid-run silently misses earlier activity.
- **All in-memory counters on restart** (§1.7 Q5).
- **Worker result metadata for review runs** (§1.7 Q3).
- **Reconciler periodic results** (§1.5).
- **`ValidationResult`** — the type and column exist; I found no writer.

---

## Phase 2 — Gap map

Derived from first principles: what must an autonomous coding-agent orchestrator answer in
production? Each desired signal is mapped to the Phase 1 inventory.

### 2.1 Outcome quality

| Desired signal | Status | Why it can't be derived today |
|---|---|---|
| Change merged | **PRESENT** | `change_per_repository.status = MERGED`, `tasks.state = MERGED/DONE` |
| Change abandoned / orphaned | **PRESENT** | same column |
| **Did the merged change survive?** (revert, `Fixes:` follow-up, hotfix within N days) | **ABSENT** | VE's knowledge of a change ends at merge. Nothing polls the target branch afterward; `reviewProgressService.ts` only tracks open changes. There is no stored base SHA / merge SHA to anchor a later "was this reverted" query — `agent_result.commits[].sha` is the *agent's* commit, and after a Gerrit rebase-on-submit that SHA no longer exists on the branch |
| **Was review feedback actually addressed, or merely replied to?** | **ABSENT** | `review_thread_replies` proves VE *answered* a human comment ([schema.ts#L177](src/state/schema.ts#L177)). `posted_review_comments.resolved` is the column that would prove resolution — and `markReviewCommentResolved` is called from exactly one place: [tests/unit/stateStore.reviewDedup.test.ts#L92](tests/unit/stateStore.reviewDedup.test.ts#L92). **No production code ever sets `resolved = 1`.** The column is permanently 0 |
| Human accepted vs. rejected VE's change | **PARTIAL** | `MERGED`/`ABANDONED` is the proxy. No capture of "merged after N human edits", because VE never re-diffs the final merged state against what it pushed |
| Cycles required per merged task | **PRESENT** | `tasks.cycle_count` at terminal state |

### 2.2 Latency decomposition

**ABSENT across the board.** Not one of the eight phases you named is timed.

| Phase | Function | Timing? |
|---|---|---|
| host workspace create | `createWorkspace()` [openShellWorkspaceRunner.ts#L216](src/workspace/openShellWorkspaceRunner.ts#L216) | no |
| clone (root + targets) | `prepareProjectWorkspace()` [#L244](src/workspace/openShellWorkspaceRunner.ts#L244) | no |
| prior-patchset checkout / cherry-pick | `applyPriorPatchset()` [#L320](src/workspace/openShellWorkspaceRunner.ts#L320) | no |
| credential provider create | [#L564](src/workspace/openShellWorkspaceRunner.ts#L564) | no |
| sandbox create | [#L578](src/workspace/openShellWorkspaceRunner.ts#L578) | no |
| egress apply | [#L587](src/workspace/openShellWorkspaceRunner.ts#L587) | no |
| skill install | [#L588](src/workspace/openShellWorkspaceRunner.ts#L588) / [skillSourceInstaller.ts#L128](src/workspace/skillSourceInstaller.ts#L128) | no (60 s timeout only) |
| upload | [#L589](src/workspace/openShellWorkspaceRunner.ts#L589) | no |
| post-clone script | [#L598](src/workspace/openShellWorkspaceRunner.ts#L598) | no |
| agent exec | [#L605](src/workspace/openShellWorkspaceRunner.ts#L605) | no |
| download | [#L615](src/workspace/openShellWorkspaceRunner.ts#L615) | no |
| push | `pushProjectChanges()` [orchestrator.ts#L1263](src/orchestrator/orchestrator.ts#L1263) | no |
| destroy | [#L641](src/workspace/openShellWorkspaceRunner.ts#L641) | no |
| review wait (`IN_REVIEW` → next) | state transitions | **PARTIAL** — derivable at 1 s granularity |

**Why it can't be derived:** the entire clone→exec→download→push span sits between two state
transitions. No intermediate marker exists. The one cross-cutting number available —
`serializeCycle`'s `durationMs` — measures *event span*, not wall-clock phase, and is null
whenever `agent_events` is empty.

### 2.3 Cost and efficiency

| Desired signal | Status | Why |
|---|---|---|
| Cost per task | **PARTIAL** | `cost_usd` sums per cycle and joins to `project_id`, but only Copilot is truthfully priced (§1.7 Q4). No per-task route — `cost-summary` groups by project only |
| **Cost per merged task** | **ABSENT** | `getCostSummary` has no join to `tasks.state`; the query groups on `t.project_id` alone ([costStore.ts](src/state/stores/costStore.ts)). Adding a state filter is trivial, so this is "absent by omission" rather than structurally impossible |
| **Cost of failed work** | **ABSENT** | same reason — no outcome dimension in the aggregate |
| Cost per engine | **ABSENT** | engine is not a column (§1.7 Q3); `model-usage` groups by `cost_model_id`, which conflates engines sharing a model |
| Cost per model | **PRESENT** | `GET /api/admin/model-usage` |
| **Cache hit behaviour** | **PRESENT** | `cost_cached_tokens` / `cost_cache_write_tokens` are aggregated by both cost routes, and the Overview SPA derives a cache-hit rate from `cached / (input + cached)` (A1) |
| Token efficiency (tokens per merged change, per modified file) | **PARTIAL** | tokens are now aggregated per project and per model (A1), but no aggregate joins them to file count or to outcome |
| Normalized cross-provider cost | **ABSENT** | three incompatible pricing tiers, one undifferentiated column (§1.7 Q4) |

### 2.4 Agent-engine comparison

**ABSENT for review, PARTIAL-and-expensive for code-gen.**

To compare eight engines on equal footing you need, per cycle: engine, model, outcome, cost,
duration, retry count, denial count. Today: engine is JSON (code-gen) or missing (review);
duration is unmeasured; cost is incomparable by construction; denial count is not attributable
to a cycle. The only clean comparison axis is *outcome* — and even that requires a
`json_extract` scan per row to know which engine produced it.

Additional confound: `projects.agent_id` is mutable and `agents.model_config_json` can be edited
in place ([schema.ts#L272](src/state/schema.ts#L272)). A historical comparison keyed on the
*current* binding silently mis-attributes every cycle that ran before an edit. The
`agent_result.metadata` snapshot is the only thing protecting code-gen from this, which is
precisely why the review path's discard of that metadata matters.

### 2.5 Reliability

| Desired signal | Status | Why |
|---|---|---|
| Failure count | **PRESENT** | `tasks.state = FAILED/ABANDONED`, overview `failedLast7d` |
| **Failure taxonomy** | **ABSENT** | `tasks.failure_reason` is a free-text string built from `err.message` ([orchestrator.ts#L1540](src/orchestrator/orchestrator.ts#L1540)). `src/utils/errorClassifier.ts` exists but its output is not persisted to a column. Grouping failures requires string clustering |
| Retry count | **PRESENT** | `cycle_count`, plus source-aware per-ticket counting |
| **Retry effectiveness** (does cycle N+1 succeed more often than N?) | **PARTIAL** | derivable: `agent_cycles.cycle_number` + `agent_result.status`. Needs JSON extraction; no route |
| **Crash recovery correctness** | **ABSENT** | `resumeActiveTasks` / `recoverActiveReviews` run at startup ([runtimeStartup.ts](src/runtime/runtimeStartup.ts)) but write no marker. Nothing distinguishes a cycle that ran clean from one resumed after a crash, and nothing counts recovery attempts or their outcomes |
| **Stuck-task detection** | **ABSENT** | requires "time in current state", which requires `now − latest transition timestamp` — computable in SQL but exposed by no route, no alert, no UI. `TASK_WORKFLOW_BUCKETS` gives `active`/`watching` counts with no age dimension ([adminOverviewRoutes.ts#L97](src/admin/adminOverviewRoutes.ts#L97)) |
| **Poison tickets** (same ticket repeatedly failing across task rows) | **PARTIAL** | the data exists — `tasks.ticket_id` is indexed and `getTaskByTicketId` orders `createdAt DESC`. But no aggregate counts failures per ticket, and `deduplicateByTicket` in the API layer actively *hides* the older rows ([adminTaskRoutes.ts#L200](src/admin/adminTaskRoutes.ts#L200)) |
| Timeout vs. error distinction | **ABSENT** | `withTimeout` throws `Agent timed out after Nms` into the same `failure_reason` string as every other error ([orchestrator.ts#L850](src/orchestrator/orchestrator.ts#L850)) |
| Sandbox leak rate | **CAPTURED, LOG-ONLY** | reconciler counts (§1.5) |

### 2.6 Saturation

| Desired signal | Status | Why |
|---|---|---|
| Current parallel cycles | **PRESENT (ephemeral)** | `GET /api/admin/concurrency` |
| **Peak parallel cycles** | **ABSENT** | counters are point-in-time; no high-water mark is kept and nothing samples the route |
| **Queue depth** | **ABSENT** | `pendingAcquisitions.length` is not in `ConcurrencySnapshot` ([concurrencyTracker.ts#L44](src/orchestrator/concurrencyTracker.ts#L44)) |
| **Wait time for a slot** | **ABSENT** | `acquireWhenAvailable` never timestamps entry (§1.7 Q5) |
| Capacity rejections | **PARTIAL** | each rejection writes a `RETRY_CYCLE` transition with a reason string ([orchestrator.ts#L695](src/orchestrator/orchestrator.ts#L695)) — countable by SQL, not aggregated anywhere |
| **Polling backoff pressure** | **ABSENT** | in-memory, log-only (§1.5) |
| Throughput | **PARTIAL** | overview bins tasks by `updated_at` into 14 polling-interval windows ([adminOverviewRoutes.ts#L43](src/admin/adminOverviewRoutes.ts#L43)). This counts *touches*, not completions — a task updated five times counts five times |

### 2.7 Security posture

| Desired signal | Status | Why |
|---|---|---|
| Policy denials recorded | **PRESENT** | `policy_denial_events` with host/method/path/reason, scrubbed |
| Denials over time | **PRESENT** | `created_at` + `idx_policy_denials_created` |
| Denial → task/project attribution | **PRESENT** | indexed columns |
| **Denial → cycle attribution** | **ABSENT** | no `cycle_number` column (§1.4). On a 3-cycle task you cannot tell which attempt triggered the denial |
| **Anomalous denial spike during a run** | **PARTIAL** | rate over time is computable, but the per-sandbox in-memory dedup ([openShellWorkspaceRunner.ts#L420](src/workspace/openShellWorkspaceRunner.ts#L420)) suppresses repeated identical lines *within* a snapshot pair while deliberately allowing duplicates across time — so "50 identical denials" and "1 denial seen twice" are not cleanly separable without care |
| **Prompt-injection indicators** | **ABSENT** | nothing inspects prompts or agent behaviour for injection. The closest adjacent signals are `permission.denied` events ([agentEventTypes.ts#L118](src/agents/agentEventTypes.ts#L118)) and network denials — a tool request or egress attempt outside the expected envelope is the observable symptom, but no rule, baseline, or counter connects them to an injection hypothesis |
| Egress denial by host | **PRESENT** | `policy_denial_events.host` |
| Admin mutation trail | **PRESENT** | `audit_log` |
| **Auth failure / brute-force signal** | **ABSENT** | login rate-limiting exists in `adminAuthRoutes.ts` but failures are not written to `audit_log` |
| Secret leakage into observability | **MITIGATED** | three independent scrubbers: events ([agentEventTypes.ts#L146](src/agents/agentEventTypes.ts#L146)), denials ([denialEvents.ts#L37](src/openshell/denialEvents.ts#L37)), audit details ([adminAudit.ts#L96](src/admin/adminAudit.ts#L96)). Any new metric/trace surface must route through equivalent masking |

### 2.8 Review-agent quality

| Desired signal | Status | Why |
|---|---|---|
| Comments posted | **PRESENT** | `posted_review_comments` rows + `metadata.commentCount` |
| Severity distribution | **CAPTURED, NOT EXPOSED** | `posted_review_comments.severity` — no read route (§1.8 item 5) |
| Comments folded by the severity/volume gate | **PARTIAL** | `foldedCount` is in events only, not cycle metadata ([reviewOrchestrator.ts#L939](src/review/reviewOrchestrator.ts#L939)) |
| **Duplicate-suppression effectiveness** | **PARTIAL** | `dedupedCount` in events only (§1.8 item 4) |
| **Human acceptance vs. dismissal of a VE comment** | **ABSENT** | `provider_thread_id` is stored, so the join key to the provider exists — but nothing ever reads the thread back to see whether a human resolved, replied to, or dismissed it. `resolved` is write-capable and never written (§2.1) |
| **Severity calibration** (are `error`-severity comments the ones humans act on?) | **ABSENT** | requires the acceptance signal above, which does not exist |
| Vote distribution | **PARTIAL** | `computeReviewVotes` reads `metadata.score` — but **caps at the 20 most recent review tasks of the last 7 days** and swallows per-task errors at `debug` level ([adminOverviewRoutes.ts#L57](src/admin/adminOverviewRoutes.ts#L57), [#L69](src/admin/adminOverviewRoutes.ts#L69)). It is an illustrative widget, not a metric |
| Replies to humans | **PRESENT (ledger)** | `review_thread_replies`, no read route |
| Review turnaround time | **ABSENT** | no phase timing; `REVIEW_RUNNING → REVIEW_COMMENTING` subtraction at 1 s resolution is the only proxy |
| Review engine attribution | **ABSENT** | §1.7 Q3 |

---

## Phase 3 — Instrumentation plan

### 3.1 Ranked gaps

Ranked by (value unlocked) / (effort). **Backfillable** = can be computed for existing rows;
**forward-only** = measures nothing about the past.

---

#### Tier A — high value, under an hour each

**A1. Expose token columns in the cost aggregates** — **SHIPPED**
- *Answers:* "Which engine/model wastes the most tokens, and is prompt caching working?"
- *Where:* `getCostSummary` and `getModelUsageSummary` ([src/state/stores/costStore.ts](src/state/stores/costStore.ts)) now `SUM` the four token columns plus a `runCountWithTokens` predicate; `CostSummaryProject` / `CostSummary` / `ModelUsageEntry` / `ModelUsageSummary` ([src/interfaces.ts](src/interfaces.ts)) carry `tokens: CycleCostTokens`. The routes needed no change — both are pure pass-throughs.
- *Schema:* none. No migration.
- *Backfill:* **fully backfillable** — columns were already populated and backfilled by `backfillLegacyCycleCosts` ([databaseMigrations.ts#L1228](src/state/databaseMigrations.ts#L1228)).
- *Effort:* under an hour. *Risk:* none (same query shape, same index).
- *Scope note the original estimate missed:* the new fields are **required**, and `tests/**` is inside `tsconfig.json`'s `include`, so the 13 test files that contextually type a `getCostSummary` / `getModelUsageSummary` mock against `AdminServerDependencies` had to be updated too. Mechanical, but it is 13 files rather than 2.

**A2. Add an outcome dimension to the cost aggregate**
- *Answers:* "What did merged work cost vs. work we threw away?"
- *Where:* same two functions — join is already there (`JOIN tasks t`), just add `t.state` to the projection/grouping, bucketed via `TASK_WORKFLOW_BUCKETS`.
- *Schema:* none.
- *Backfill:* **fully backfillable.**
- *Effort:* under an hour. *Risk:* none.

**A3. Persist `cycle_number` on policy denials**
- *Answers:* "Which cycle of this task tried to reach a blocked host?"
- *Where:* add `cycleNumber` to `DenialContext` ([src/openshell/denialEvents.ts#L21](src/openshell/denialEvents.ts#L21)); pass it at the recording call site ([src/workspace/openShellWorkspaceRunner.ts#L420](src/workspace/openShellWorkspaceRunner.ts#L420)) — note this requires threading the cycle number into `runAgentInDocker`, which currently does not receive it.
- *Schema:* `policy_denial_events.cycle_number INTEGER NULL` → **Drizzle migration required** (`drizzle/0003_*.sql`).
- *Backfill:* **forward-only.** Existing rows can at best be heuristically attributed by timestamp-vs-cycle-window, which is unreliable and should not be attempted.
- *Effort:* under an hour once plumbing is in place. *Risk:* one extra nullable column; negligible write amplification.

**A4. Promote `dedupedCount` / `foldedCount` into review cycle metadata**
- *Answers:* "How much noise is the dedup ledger actually suppressing?"
- *Where:* the `cycleResult.metadata` object at [src/review/reviewOrchestrator.ts#L1028](src/review/reviewOrchestrator.ts#L1028) — the values are already in scope.
- *Schema:* none (JSON blob).
- *Backfill:* **backfillable** by reprocessing `agent_events` (the `review.completed` event already carries both).
- *Effort:* under an hour. *Risk:* none.

**A5. Record the engine on review cycles**
- *Answers:* "Which of the eight engines produced this review, historically?"
- *Where:* **three files** — the metadata is discarded earlier than the cycle-write, so this is not a one-line change:
  1. [src/workspace/agentWorkerProtocol.ts#L14](src/workspace/agentWorkerProtocol.ts#L14) — `decodeReviewWorkerOutput` validates the whole worker envelope but returns **only** `rawOutput: string`. `metadata` is dropped here, at the workspace boundary. Widen the return to `{ rawOutput, workerMetadata?: Record<string, unknown> }`.
  2. [src/interfaces.ts#L717](src/interfaces.ts#L717) and [src/workspace/openShellWorkspaceRunner.ts#L473](src/workspace/openShellWorkspaceRunner.ts#L473) — the `runReviewInDocker` contract is `Promise<{ rawOutput: string }>` and has no slot to carry it. Widen both. Keeping the new field **optional** means none of the ~10 `vi.fn(async () => ({ rawOutput }))` mocks in `tests/unit/reviewOrchestrator.test.ts` / `reviewLiveLogs.test.ts` break.
  3. [src/review/reviewOrchestrator.ts#L1028](src/review/reviewOrchestrator.ts#L1028) — merge `adapter` / `model` / `reviewStrategy` into the host-built `cycleResult.metadata` (host-owned keys must win on collision, so a compromised worker cannot forge `vote` or `patchset`).
- *Source of truth:* the worker already produces `{ adapter, model, reviewMode, reviewStrategy }` at [agent-worker/src/index.ts#L338](agent-worker/src/index.ts#L338); nothing new needs to be computed.
- *Schema:* none — `agent_result` is already a JSON blob.
- *Backfill:* **forward-only.** Historical review cycles never stored the adapter; `session.start` in `agent_events` gives `model` only, which is ambiguous across Aider/Goose/OpenCode/Claude (all can report the same Anthropic model id).
- *Effort:* under an hour. *Risk:* the `rawOutput`-only return is arguably a deliberate trust boundary — worker output is untrusted, and today exactly one string crosses it. Widening it means `workerMetadata` must be treated as untrusted: allowlist the three keys, coerce to string, bound the length, and never let it override a host-computed field.

**A6. Surface the concurrency snapshot + add queue depth**
- *Answers:* "Are we slot-starved right now, and how deep is the queue?"
- *Where:* extend `ConcurrencySnapshot` with `pendingCount` ([src/orchestrator/concurrencyTracker.ts#L44](src/orchestrator/concurrencyTracker.ts#L44), populated from `pendingAcquisitions.length`); render in the SPA (route already exists at [adminConcurrencyRoutes.ts#L13](src/admin/adminConcurrencyRoutes.ts#L13)).
- *Schema:* none.
- *Backfill:* **N/A — instantaneous gauge, forward-only by nature.**
- *Effort:* under an hour. *Risk:* none.

**A7. Expose polling backoff state on `/api/admin/status`**
- *Answers:* "Is the ticket source degraded?"
- *Where:* `getIntervals()` in [src/orchestrator/pollingLoop.ts#L121](src/orchestrator/pollingLoop.ts#L121) → return `ticketFailureCount` and `ticketBackoffUntil`; project them at [src/admin/adminServer.ts#L365](src/admin/adminServer.ts#L365).
- *Schema:* none. *Backfill:* N/A (gauge). *Effort:* under an hour. *Risk:* none.

---

#### Tier B — high value, about a day each

**B1. Phase timing for the workspace lifecycle**
- *Answers:* "Which phase dominates cycle latency — clone, sandbox create, agent exec, or push?"
- *Where:* wrap each phase in `runAgentInDocker` ([src/workspace/openShellWorkspaceRunner.ts#L542-L628](src/workspace/openShellWorkspaceRunner.ts#L542)) and `runReviewInDocker` ([#L467-L538](src/workspace/openShellWorkspaceRunner.ts#L467)) with a small `withPhase(name, fn)` helper that records `{phase, ms, ok}`. Emit each as an `AgentLogEvent` of a new type `phase.completed` so it rides the existing `agentLogBus` → `agent_events` path with zero new persistence machinery; *additionally* write a typed summary object onto `agent_result.metadata.phases`.
- *Schema:* none if you use `agent_events` + metadata. A dedicated `agent_cycle_phases` table would be cleaner for querying but needs a migration — recommend starting with the JSON path and promoting later once the phase list stabilises.
- *Backfill:* **forward-only.** Nothing in history distinguishes phases.
- *Effort:* a day. *Risk:* one `Date.now()` per phase — negligible hot-path cost. If you add a table instead, that is ~12 extra INSERTs per cycle: still trivial against SQLite WAL, but it is real write amplification on a high-throughput instance.

**B2. Failure taxonomy column**
- *Answers:* "Are failures dominated by timeouts, provider 5xx, git conflicts, or policy denials?"
- *Where:* `handleFatalError` [src/orchestrator/orchestrator.ts#L1540](src/orchestrator/orchestrator.ts#L1540) and the catch block at [#L940](src/orchestrator/orchestrator.ts#L940); classify with the existing `src/utils/errorClassifier.ts` and persist alongside the free-text reason.
- *Schema:* `tasks.failure_class TEXT NULL` (and ideally `agent_cycles.failure_class`) → **Drizzle migration required.**
- *Backfill:* **partially backfillable** — `failure_reason` strings can be re-run through the classifier offline for existing rows. Flag backfilled rows (`failure_class_source = 'backfill'`) so a reclassification change doesn't silently rewrite history semantics.
- *Effort:* a day. *Risk:* classifier drift makes historical buckets non-comparable; mitigate by versioning the classifier and storing its version.

**B3. Slot wait time + peak concurrency**
- *Answers:* "How long do cycles queue, and what's our true peak parallelism?"
- *Where:* timestamp on entry to `acquireWhenAvailable`, emit the delta on `acquireSlot` success ([src/orchestrator/concurrencyTracker.ts](src/orchestrator/concurrencyTracker.ts)); track a high-water mark on `activeGlobal`/`perIntegration`.
- *Schema:* none if emitted as a metric/event; a column on `agent_cycles` (`queue_wait_ms`) if you want it queryable per cycle → migration.
- *Backfill:* **forward-only.**
- *Effort:* a day. *Risk:* none.

**B4. Review-comment acceptance tracking**
- *Answers:* "Do humans act on VE's comments, and is severity calibrated?"
- *Where:* a new poll in `reviewProgressService.ts` (or piggy-backed on the existing `REVIEW_WATCHING` tick) that reads thread state back from the provider by `provider_thread_id` and calls the already-existing `markReviewCommentResolved` ([src/state/stores/reviewDedupStore.ts#L116](src/state/stores/reviewDedupStore.ts#L116)) — **currently called only by a test**.
- *Schema:* `posted_review_comments` already has `resolved` and `provider_thread_id`. To distinguish *resolved* from *dismissed* you need one more column (`outcome TEXT`) → migration. Requires a `VcsConnector`/review-provider capability to read thread resolution state, which may not exist for all three backends — **verify per provider before committing.**
- *Backfill:* **partially** — threads on still-open changes can be read retroactively; merged/abandoned changes generally cannot.
- *Effort:* more than a day (provider capability work dominates). *Risk:* extra provider API calls on every watch tick — rate-limit budget matters.

**B5. Read routes for the review ledgers + aggregate transitions**
- *Answers:* severity distribution, comment volume per change, funnel/time-in-state.
- *Where:* new routes in `adminTaskRoutes.ts` or a new `adminAnalyticsRoutes.ts`; stores already expose the reads.
- *Schema:* none. *Backfill:* **fully backfillable.** *Effort:* a day. *Risk:* unbounded queries — cap with `limit` like `adminDenialRoutes.ts` does.

---

#### Tier C — high value, more than a day

**C1. Post-merge survival tracking**
- *Answers:* "Did VE's merged change get reverted or hot-fixed?"
- *Where:* new scheduled job alongside the sandbox reconciler in `src/runtime/runtimeStartup.ts`; needs the merge commit SHA captured at merge time in `pushProjectChanges`/`reviewProgressService`, plus a `VcsConnector` method to search the target branch for reverts.
- *Schema:* `change_per_repository.merged_sha TEXT NULL`, plus a `change_outcomes` table → migration.
- *Backfill:* **forward-only.** The merge SHA was never recorded; Gerrit rebase-on-submit means the agent's SHA is not the branch SHA.
- *Effort:* more than a day. *Risk:* sustained provider API load; a long-running background job that must not interfere with the concurrency model.

**C2. OpenTelemetry tracing across the host/sandbox boundary** — see §3.3.
- *Backfill:* **forward-only.** *Effort:* more than a day.

**C3. Prometheus exporter** — see §3.2.
- *Backfill:* **forward-only** (counters start at zero on the day it ships; historical answers must still come from SQLite).
- *Effort:* a day for the exporter, more for a stable catalogue.

---

### 3.2 Target design — metric catalogue

Principles:

- Names are `ve_<domain>_<noun>_<unit>`, stable across releases.
- **`task_id`, `ticket_id`, `change_id`, `user`, and any free text are NEVER labels** — they are
  unbounded. They belong in the DB and in logs. This is the single most important rule: label
  cardinality is how a metrics backend gets destroyed, and `failure_reason` as a label would
  also be a secret-leakage vector (it is derived from `err.message`, which the event sanitizer
  scrubs but the error path does not).
- Label values come from the existing closed vocabularies: `TaskState`, `TaskType`,
  `DomainCapability`, `ProviderId`, `RuntimePolicyKind`, `AgentResultStatus`.
- `project_id` and `integration_id` are bounded in practice (tens), so they are admissible —
  but cap them and document the cap.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `ve_task_state_total` | gauge | `state` (TaskState), `task_type` | poll `tasks` |
| `ve_task_transitions_total` | counter | `from_state`, `to_state`, `task_type` | `taskStore.transition` |
| `ve_task_time_in_state_seconds` | histogram | `state`, `task_type` | on transition, from previous row |
| `ve_cycle_total` | counter | `engine`, `model`, `status` (AgentResultStatus), `task_type`, `project_id` | `saveAgentCycle` |
| `ve_cycle_duration_seconds` | histogram | `engine`, `task_type` | B1 |
| `ve_cycle_phase_duration_seconds` | histogram | `phase`, `task_type` | B1 |
| `ve_cycle_tokens_total` | counter | `engine`, `model`, `kind` ∈ {input,output,cache_read,cache_write} | `computeCycleCost` |
| `ve_cycle_cost_usd_total` | counter | `engine`, `model`, `cost_source` (§3.5) | `computeCycleCost` |
| `ve_cycle_failures_total` | counter | `engine`, `failure_class` (B2), `task_type` | B2 |
| `ve_concurrency_active` | gauge | `integration_id` | `ConcurrencyTracker.snapshot` |
| `ve_concurrency_queue_depth` | gauge | `integration_id` | B3 |
| `ve_concurrency_wait_seconds` | histogram | `integration_id` | B3 |
| `ve_concurrency_rejections_total` | counter | `integration_id` | `acquire() → null` |
| `ve_polling_failures_total` | counter | `capability`, `provider` | `pollingLoop` catch |
| `ve_polling_backoff_seconds` | gauge | `capability` | `pollingLoop` |
| `ve_policy_denials_total` | counter | `category`, `host`, `decision` — **`path` and `reason` excluded** (unbounded + secret-bearing even after scrubbing) | `denialStore.record` |
| `ve_review_comments_total` | counter | `severity`, `disposition` ∈ {posted,folded,deduped} | `reviewOrchestrator` |
| `ve_review_votes_total` | counter | `vote` ∈ {-2,-1,0,1,2}, `provider` | `reviewOrchestrator` |
| `ve_sandbox_reconcile_total` | counter | `kind` ∈ {sandbox,provider}, `result` ∈ {deleted,failed,skipped} | reconciler |
| `ve_agent_tool_calls_total` | counter | `engine`, `tool`, `outcome` ∈ {success,error,denied} | `agent_events` |
| `ve_build_info` | gauge (=1) | `version`, `openshell_version` | startup |

### 3.3 Target design — span boundaries and cross-boundary trace propagation

The host↔sandbox boundary is the interesting part, because the worker communicates over stdout
(result envelope) and stderr (`__ve_event` frames), not over a network protocol that a tracing
SDK could auto-instrument.

**Host spans** (parent → child):

```
ve.task.workflow                       # per runWorkflow entry, attrs: task_type, project_id, state
└── ve.cycle                           # per agent cycle; attrs: cycle_number, engine, model
    ├── ve.workspace.create
    ├── ve.workspace.clone             # attrs: target_count
    ├── ve.workspace.checkout_prior
    ├── ve.sandbox.provider_create
    ├── ve.sandbox.create              # attrs: image, retry_attempt
    ├── ve.sandbox.egress_apply
    ├── ve.workspace.skill_install     # attrs: source_count
    ├── ve.sandbox.upload              # attrs: bytes
    ├── ve.sandbox.post_clone_script
    ├── ve.sandbox.exec                # ← the boundary span
    ├── ve.sandbox.download
    ├── ve.vcs.push                    # attrs: repo_key, review_system
    └── ve.sandbox.destroy
```

Each maps 1:1 to a function already identified in §2.2, so span placement is mechanical.

**Crossing the boundary.** Two viable mechanisms, and I'd do both:

1. **Inject W3C `traceparent` as sandbox env.** Add `VE_TRACEPARENT` (and `VE_TRACE_STATE`) to
   the env map built in `buildCodegenContainerSpec` / `buildReviewContainerSpec`
   ([src/agents/containerSpecBuilders.ts#L44](src/agents/containerSpecBuilders.ts#L44), [#L76](src/agents/containerSpecBuilders.ts#L76)).
   The worker reads it and either (a) starts a real child span if you ship an OTel SDK into the
   worker image, or (b) simply echoes it back on every `__ve_event` frame. Option (b) is far
   cheaper and probably sufficient.
   **Note this also fixes an independent defect:** the review spec currently carries *no* task
   identity at all, so a review sandbox's own logs cannot be correlated to a task even manually.
   Add `TASK_ID` and `CYCLE_NUMBER` to both specs while you are there.
2. **Reconstruct child spans host-side from `__ve_event` frames.** The events already carry ISO
   timestamps ([agent-worker/src/providers/events.ts#L8](agent-worker/src/providers/events.ts#L8))
   and the host already stamps `taskId`/`cycleNumber` onto them
   ([src/agents/agentStderrPipeline.ts#L40](src/agents/agentStderrPipeline.ts#L40)). That
   pipeline is the natural place to translate `tool.execution_start`/`tool.execution_complete`
   pairs into child spans of `ve.sandbox.exec`, and `session.error` / `permission.denied` into
   span events. **No worker change at all** for the Copilot path, which already reports
   `durationMs`; the other seven engines would produce zero-duration spans until they emit
   start/end timestamps, which is itself a reason to standardise that in the shared provider
   event helper.

**Attribute hygiene.** Span attributes must go through `sanitizeEventData`
([src/agents/agentEventTypes.ts#L182](src/agents/agentEventTypes.ts#L182)) before export. Never
attach prompt content, diff content, `failure_reason`, `agentLogs`, or MCP arguments. The
existing code is already careful here (permission events retain kind/call/server/tool/path but
never MCP arguments) — a tracing layer must not become the hole that undoes it.

### 3.4 Target design — DB vs. metrics vs. logs

| Signal class | Destination | Reasoning |
|---|---|---|
| Task/cycle outcomes, cost, engine, model, failure class, review ledgers, denials, audit | **DB (durable, queryable)** | These are *records*, not samples. You need to answer "show me every Claude cycle that failed with a timeout on project X last month" — an arbitrary-cardinality historical query a TSDB cannot serve. They also need per-task drill-down from the UI. Already the right home; the gaps are missing columns and missing read routes, not a wrong destination |
| Phase durations | **Both** | DB (on `agent_cycles`) for per-cycle forensics — "why was *this* task slow"; metrics histogram for "which phase dominates p95 across the fleet". The DB copy is what makes the answer backfillable-forward and drill-downable |
| Concurrency, queue depth, wait time, backoff, reconciler counts | **Metrics only** | Pure time-series with no per-entity identity worth keeping. Writing a DB row per sample is write amplification with no query value. Today these are log-only, which is the worst of both worlds |
| Rates and distributions derived from DB records (cycles/min, denial rate, token rate) | **Metrics, derived at emit time** | Do not make the metrics layer read SQLite on scrape. Increment counters at the same call site that writes the row |
| Agent event stream, raw agent output, error stack traces, provider HTTP failures, git command stderr | **Logs (+ the bounded `agent_events` blob)** | High volume, free-text, secret-adjacent. Useful for one incident, useless as a dimension. The existing `agent_events` retention is the right compromise — but see the retention concern in `docs/CODE_QUALITY_AUDIT.md#L125` |
| Admin mutations | **DB only** | Append-only compliance record; already correct |

Two structural prerequisites before any exporter ships:
- **Turn off `pino-pretty` outside interactive dev.** It is currently enabled for every
  `NODE_ENV !== production` ([src/logger.ts#L24](src/logger.ts#L24)), which is the default —
  so the default deployment emits unparseable logs.
- **Bind `taskId`/`cycleNumber` at the child-logger level** rather than relying on every call
  site to remember. `getLogger(component)` ([src/logger.ts#L38](src/logger.ts#L38)) should gain
  a `.child({ taskId, cycleNumber })` convention in the orchestrator and runner.

### 3.5 Target design — unified cost attribution

Three provider tiers (§1.7 Q4) currently collapse into one ambiguous `cost_usd`. Proposal:

**Add a provenance discriminator.**

```
agent_cycles.cost_source TEXT NULL   -- Drizzle migration required
```

with a closed vocabulary:

| Value | Meaning | Providers |
|---|---|---|
| `provider_aiu` | Provider-computed, authoritative | copilot (when `totalNanoAiu` present) |
| `estimated_premium_request` | `premiumRequests × $0.04` heuristic | copilot (AIU absent) |
| `derived_token_price` | VE-computed from tokens × a price-book rate | claude, aider, codex, gemini, goose, opencode |
| `unavailable` | No usage signal at all | cursor |

`computeCycleCost` ([src/agents/cycleCost.ts#L57](src/agents/cycleCost.ts#L57)) already
distinguishes the first two internally via `priced`; it just doesn't persist the distinction.

**Add a price book for the token-only tier.** A small table (or a versioned JSON config —
a table is better, since rates change and you need the rate that applied *at the time*):

```
model_prices(model_id, effective_from, usd_per_1k_input, usd_per_1k_output,
             usd_per_1k_cache_read, usd_per_1k_cache_write, source)
```

`computeCycleCost` looks up the rate effective at cycle time and emits
`cost_source = 'derived_token_price'`. This makes six more engines cost-comparable. Critically,
because the rate is stored per-cycle-time rather than applied at read time, a later price change
does not silently rewrite historical cost.

**Rules for consumers.** `getCostSummary` must return cost **broken out by `cost_source`**, not
a single total. A UI that shows one number across a Copilot project and a Cursor project is
lying. Concretely:

- `totalUsd` becomes `usdByCostSource: Record<CostSource, number>` plus an explicitly-labelled
  `usdComparable` (= `provider_aiu` + `derived_token_price`).
- `runCount` gains `runCountUnpriced` so "we spent $0" and "we can't see what we spent" are
  distinguishable at a glance. **A1 already established this pattern on the token side with
  `runCountWithTokens`** — the USD side should mirror it rather than invent a second shape.

**Backfill:** `cost_source` is **fully backfillable** — `agent_events` is retained per cycle, so
`computeCycleCost` can be re-run offline over history exactly as `backfillLegacyCycleCosts`
already does ([src/state/databaseMigrations.ts#L1228](src/state/databaseMigrations.ts#L1228)).
`derived_token_price` amounts are backfillable **only if** the price book carries rates with
`effective_from` reaching back far enough; otherwise backfilled rows should be marked
`derived_token_price_approx`. Cursor rows stay `unavailable` forever — no amount of
instrumentation recovers a number the CLI never emitted.

**Cursor is a hard limitation, not a gap to close.** Its documented `stream-json` terminal
`result` event has no token or cost field ([agent-worker/src/providers/cursor.ts#L45](agent-worker/src/providers/cursor.ts#L45)).
Any fleet-wide cost figure must therefore report Cursor coverage explicitly rather than
averaging it in as zero.

---

## Uncertainties

Stated plainly rather than assumed:

1. **`ValidationResult` writers.** The type ([src/interfaces.ts#L588](src/interfaces.ts#L588))
   and column ([src/state/schema.ts#L86](src/state/schema.ts#L86)) exist, and
   `saveAgentCycle` accepts an optional `validationResult`
   ([src/state/stores/taskStore.ts#L527](src/state/stores/taskStore.ts#L527)). I found no
   orchestrator or review call site that passes it. I did not exhaustively search every caller
   — if one exists, `validation_result.durationMs` would be the second measured duration in the
   system.
2. **`posted_review_comments.resolved`.** Grep found `markReviewCommentResolved` at
   [src/state/stores/reviewDedupStore.ts#L116](src/state/stores/reviewDedupStore.ts#L116),
   its interface declaration at [src/interfaces.ts#L1414](src/interfaces.ts#L1414), and exactly
   one caller — a test at [tests/unit/stateStore.reviewDedup.test.ts#L92](tests/unit/stateStore.reviewDedup.test.ts#L92).
   I conclude no production path sets it, but this is an absence-of-evidence claim.
3. **Provider capability for reading review-thread resolution state** (needed for B4). I did not
   verify whether the Gerrit, GitLab, and GitHub review providers each expose thread-resolution
   reads. Verify per connector in `src/connectors/` before scoping that work.
4. **`errorClassifier.ts` output shape.** I confirmed the file exists at
   `src/utils/errorClassifier.ts` and that no classification is persisted to a column, but I did
   not read its classification vocabulary. B2's label set must be derived from it, not invented.
5. **Line numbers** in this document were read at audit time and will drift with edits; the
   function and file references are the durable part.
