import type { ApiCycle } from "../../types.ts";

export interface CyclePresentation {
  status: ApiCycle["result"]["status"];
  tone: "active" | "ok" | "warn" | "danger";
  error: string | null;
}

export function getCyclePresentation(cycle: ApiCycle): CyclePresentation {
  const { result } = cycle;
  const tone = result.status === "running"
    ? "active"
    : result.status === "success"
    ? "ok"
    : result.status === "no_change"
      ? "warn"
      : "danger";

  if (result.status !== "failed") {
    return { status: result.status, tone, error: null };
  }

  const metadataError = result.metadata["error"];
  const error = typeof metadataError === "string" && metadataError.trim().length > 0
    ? metadataError
    : result.summary.trim().length > 0
      ? result.summary
      : result.agentLogs.trim().length > 0
        ? result.agentLogs
        : null;

  return { status: result.status, tone, error };
}
