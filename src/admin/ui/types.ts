/* ─── API response shapes ─────────────────────────────────────────────── */

export type TaskState =
  | "DETECTED" | "CONTEXT_BUILDING" | "AGENT_RUNNING"
  | "IN_REVIEW" | "FEEDBACK_PROCESSING" | "RETRY_CYCLE"
  | "MERGED" | "CLOSING" | "DONE" | "FAILED" | "ABANDONED"
  | "REVIEW_PENDING" | "REVIEW_RUNNING" | "REVIEW_COMMENTING"
  | "REVIEW_WATCHING" | "REVIEW_DONE" | "REVIEW_FAILED";

export type TaskType = "code-gen" | "code-review";

export interface ApiTask {
  taskId: string;
  taskType: TaskType;
  ticketId: string;
  ticketSourceLabel: string;
  ticketTitle: string;
  ticketDescription: string;
  state: TaskState;
  gerritChangeId: string | null;
  currentPatchset: number;
  reviewedPatchset: number | null;
  cycleCount: number;
  failureReason: string | null;
  ticketUrl: string | null;
  reviewUrl: string | null;
  displayId: string | null;
  createdAt: string;
  updatedAt: string;
  changesPerRepo?: ChangePerRepo[];
}

export interface ChangePerRepo {
  repoKey: string;
  changeId: string;
  reviewUrl: string | null;
  status: string;
  reviewSystem: string;
  commitIndex: number;
  subjectHash: string | null;
}

export interface AgentLogEvent {
  type: string;
  timestamp: string;
  data: unknown;
  taskId: string;
  cycleNumber: number;
}

export interface AgentResult {
  status: "success" | "no_change" | "failed";
  modifiedFiles: string[] | Record<string, string[]>;
  summary: string;
  agentLogs: string;
  agentEvents?: AgentLogEvent[];
  externalChangeId?: string;
  metadata: Record<string, unknown>;
}

export interface ValidationResult {
  status: "passed" | "failed" | "skipped";
  testOutput: string;
  lintOutput: string;
  durationMs: number;
}

export interface ApiCycle {
  id: number;
  taskId: string;
  cycleNumber: number;
  result: AgentResult;
  validationResult: ValidationResult | null;
  createdAt: string;
  /** Wall-clock ms from cycle start to last agent event. Null when no events were recorded. */
  durationMs: number | null;
  /** GitHub-computed cost for the cycle. Null when no usage data was captured. */
  cost: CycleCost | null;
}

export interface CycleCostTokens {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

export interface CycleCost {
  priced: boolean;
  aiCredits: number;
  usd: number;
  premiumRequests: number;
  tokens: CycleCostTokens;
  modelId: string | null;
}

export interface ApiTransition {
  id: number;
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type DomainCapability = "issue_tracking" | "code_review" | "source_control" | "agent_execution";

/**
 * Provider brand icon metadata as serialized by the admin API. `slug` is the
 * simpleicons.org slug and `hex` is the brand colour without the leading `#`.
 */
export interface ProviderIcon {
  slug: string;
  hex: string;
}

export interface ApiIntegration {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  active?: boolean;
  capabilities: string[];
  domainCapabilities: DomainCapability[];
  icon?: ProviderIcon | null;
  config?: Record<string, string>;
  discoverySupported?: boolean;
  streamEventsSupported?: boolean;
  streamStatus?: unknown;
  discoveredAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  discoveredResources?: {
    ticketProjects?: Array<{
      key: string;
      name: string;
      url?: string;
    }>;
    repositories?: Array<{
      key: string;
      name: string;
      cloneUrlSsh?: string;
      cloneUrlHttp?: string;
      defaultBranch?: string;
      branches?: string[];
      webUrl?: string;
    }>;
    models?: Array<{
      id: string;
      name: string;
      vendor?: string;
      version?: string;
      category?: string;
      contextWindowTokens?: number;
      capabilities?: unknown;
      supportedReasoningEfforts?: string[];
    }>;
    discoveredAt?: string;
  } | null;
}

export interface PluginField {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "number" | "select" | "textarea";
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  dependsOn?: { field: string; value: string };
  /** When true the field is not rendered in the UI (managed internally by OAuth flows etc.). */
  hidden?: boolean;
  /** When true the field is rendered inside a collapsed Advanced settings section. */
  advanced?: boolean;
}

export interface ApiPluginOAuth {
  mode: "device";
  tokenField: string;
  dependsOn?: { field: string; value: string };
  providerName: string;
  heading: string;
  connectLabel: string;
  reconnectLabel: string;
  pendingLabel: string;
  startPath: string;
  completePath: string;
}

export interface ApiPlugin {
  provider: string;
  name: string;
  capabilities: string[];
  domainCapabilities: DomainCapability[];
  icon?: ProviderIcon | null;
  requiredFields: PluginField[];
  oauth?: ApiPluginOAuth;
}

export interface ApiAgent {
  id: string;
  name: string;
  type: "coding" | "review";
  integrationId: string | null;
  enabled: boolean;
  maxConcurrent: number | null;
  model: string | null;
  systemPromptId: string | null;
  instructionsPromptId: string | null;
  feedbackInstructionsPromptId: string | null;
  modelConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProject {
  id: string;
  name: string;
  type: "coding" | "review";
  enabled: boolean;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiPrompt {
  id: string;
  label: string;
  content: string;
  updatedAt: string;
  usedByCount?: number;
}

export interface ApiOAuthApp {
  provider: string;
  baseUrl: string;
  clientId: string;
}

export interface ApiStatus {
  polling: { running: boolean; intervalMs: number };
  runtime: {
    nodeEnv: string;
    logLevel: string;
    maxAgentCycles: number;
    maxRetryAttempts: number;
  };
}

export interface ApiConfig {
  config: {
    nodeEnv: string;
    logLevel: string;
    maxAgentCycles: number;
    maxRetryAttempts: number;
    pollingIntervalMs: number;
  };
}

export interface ApiProvider {
  id: string;
  name: string;
  category: "ticketing" | "review" | "agent" | "runtime";
  enabled: boolean;
  configured: boolean;
  status: "ready" | "disabled" | "incomplete";
  details: string[];
}

export interface ApiOverview {
  stats: {
    activeTasks: number;
    watchingTasks: number;
    completedLast7d: number;
    failedLast7d: number;
    activeProviders: number;
  };
  throughput: number[];        // last 14 polling ticks
  reviewVotes: { plus2: number; plus1: number; minus1: number; minus2: number };
  runtime: {
    environment: string;
    version: string;
    uptime: string;
    dbSize: string;
    maxCycles: number;
    maxRetries: number;
    pollingInterval: string;
    logLevel: string;
  };
}

export interface ApiCostSummaryProject {
  projectId: string | null;
  projectName: string | null;
  usd: number;
  aiCredits: number;
  premiumRequests: number;
  runCount: number;
}

export interface ApiCostSummary {
  totalUsd: number;
  totalAiCredits: number;
  totalPremiumRequests: number;
  totalRuns: number;
  perProject: ApiCostSummaryProject[];
  sinceEpochSeconds: number | null;
}

export interface ApiModelUsageEntry {
  modelId: string | null;
  runCount: number;
  usd: number;
}

export interface ApiModelUsageProject {
  projectId: string | null;
  projectName: string | null;
  models: ApiModelUsageEntry[];
}

export interface ApiModelUsageSummary {
  byModel: ApiModelUsageEntry[];
  perProject: ApiModelUsageProject[];
  totalRuns: number;
  totalUsd: number;
  sinceEpochSeconds: number | null;
}

/* ─── Auth / users / audit ────────────────────────────────────────────── */

export type UserRole = "admin" | "operator" | "viewer";

/** Current identity from GET /api/admin/auth/me. `id` is null in bootstrap mode (no users yet — see adminServer.ts). */
export interface ApiMe {
  id: string | null;
  username: string;
  role: UserRole;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface ApiUser {
  id: string;
  username: string;
  role: UserRole;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAuditEntry {
  id: number;
  actorUserId: string | null;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ApiAuditPage {
  entries: ApiAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

/* ─── Bootstrap injected by the server ────────────────────────────────── */
export interface VeAdminBootstrap {
  requiresAuth: boolean;
  authMode: "none" | "bearer" | "hmac" | "mixed";
  gerritBaseUrl: string | null;
  gitlabBaseUrl: string | null;
  ticketLinkTemplates: Record<string, string>;
  providerLogos?: Record<string, string>;
}

declare global {
  interface Window {
    __VE_ADMIN_BOOTSTRAP__?: VeAdminBootstrap;
  }
}
