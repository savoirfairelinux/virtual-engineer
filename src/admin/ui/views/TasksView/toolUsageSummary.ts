/**
 * Aggregate tool-usage metrics from a cycle's `agentEvents` for the persisted
 * "Tool usage" section in the cycle card. Mirrors the live `liveMetrics.ts`
 * dedup logic but works on the persisted `AgentLogEvent[]` shape.
 */
import type { AgentLogEvent } from "../../types.js";

export interface ToolUsageRow {
  name: string;
  callCount: number;
  denialCount: number;
  lastDenialReason: string | null;
}

export interface ToolUsageSummary {
  totalCalls: number;
  totalDenials: number;
  tools: ToolUsageRow[];
}

export function summarizeToolUsage(events: AgentLogEvent[] | undefined): ToolUsageSummary {
  if (!events || events.length === 0) {
    return { totalCalls: 0, totalDenials: 0, tools: [] };
  }
  const tools = new Map<string, ToolUsageRow>();
  let totalCalls = 0;
  let totalDenials = 0;
  const seenCallIds = new Set<string>();

  for (const ev of events) {
    const data = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    if (ev.type === "tool.execution_start") {
      const name = typeof data["name"] === "string" ? data["name"]
        : typeof data["toolName"] === "string" ? data["toolName"]
        : typeof data["tool"] === "string" ? data["tool"]
        : "unknown";
      const callId = typeof data["callId"] === "string" ? data["callId"]
        : typeof data["toolCallId"] === "string" ? data["toolCallId"]
        : null;
      const callNumber = typeof data["callNumber"] === "number" ? data["callNumber"] : null;
      const key = callId ?? (callNumber !== null ? `${name}#${callNumber}` : null);
      if (key !== null) {
        if (seenCallIds.has(key)) continue;
        seenCallIds.add(key);
      }
      totalCalls++;
      const row = tools.get(name) ?? { name, callCount: 0, denialCount: 0, lastDenialReason: null };
      row.callCount++;
      tools.set(name, row);
    } else if (ev.type === "permission.denied") {
      totalDenials++;
      const name = typeof data["toolName"] === "string" ? data["toolName"]
        : typeof data["tool"] === "string" ? data["tool"]
        : typeof data["name"] === "string" ? data["name"]
        : null;
      if (name) {
        const row = tools.get(name) ?? { name, callCount: 0, denialCount: 0, lastDenialReason: null };
        row.denialCount++;
        const reason = typeof data["reason"] === "string" ? data["reason"]
          : typeof data["message"] === "string" ? data["message"]
          : typeof data["feedback"] === "string" ? data["feedback"]
          : null;
        row.lastDenialReason = reason;
        tools.set(name, row);
      }
    }
  }

  const rows = [...tools.values()].sort((a, b) =>
    b.callCount + b.denialCount - (a.callCount + a.denialCount) ||
    a.name.localeCompare(b.name),
  );
  return { totalCalls, totalDenials, tools: rows };
}
