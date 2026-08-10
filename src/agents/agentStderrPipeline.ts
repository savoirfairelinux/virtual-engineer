import type { Logger } from "pino";
import type { AgentLogEvent, TaskContext } from "../interfaces.js";
import { agentLogBus, pushToTaskBuffer } from "./agentEventBus.js";

export interface StderrParseState {
  buffer: string;
  plainLogLines: string[];
  agentEvents: AgentLogEvent[];
}

export interface AgentStderrPipelineOptions {
  /** Adapter name embedded in log messages, e.g. "copilot", "claude". */
  adapterName: string;
  log: Logger;
  /** Invoked after every structured `__ve_event` line is parsed (Copilot's live-event logging). */
  onEvent?: ((event: AgentLogEvent) => void) | undefined;
}

export interface AgentStderrPipeline {
  readonly state: StderrParseState;
  /** Accumulate a stderr chunk into the line buffer and process complete lines. */
  consumeChunk(chunk: string): void;
  /** Process any remaining buffered content as a final line. */
  flush(): void;
}

/** Build a stderr line-buffering pipeline shared across agent adapters, bound to one task context. */
export function createStderrPipeline(
  context: TaskContext,
  options: AgentStderrPipelineOptions
): AgentStderrPipeline {
  const state: StderrParseState = {
    buffer: "",
    plainLogLines: [],
    agentEvents: [],
  };

  function processLine(line: string): void {
    if (!line) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record["__ve_event"] === true) {
          const event: AgentLogEvent = {
            type: typeof record["type"] === "string" ? record["type"] : "unknown",
            timestamp: typeof record["ts"] === "string" ? record["ts"] : new Date().toISOString(),
            data: record["data"],
            taskId: context.taskId,
            cycleNumber: context.cycleNumber,
          };
          state.agentEvents.push(event);
          options.onEvent?.(event);
          pushToTaskBuffer(event);
          agentLogBus.emit("event", event);
          return;
        }
      }
    } catch {
      // plain stderr line
    }

    state.plainLogLines.push(line);
    const stderrEvent: AgentLogEvent = {
      type: "stderr.line",
      timestamp: new Date().toISOString(),
      data: { line },
      taskId: context.taskId,
      cycleNumber: context.cycleNumber,
    };
    pushToTaskBuffer(stderrEvent);
    agentLogBus.emit("event", stderrEvent);
    options.log.info(
      { taskId: context.taskId, cycle: context.cycleNumber, line },
      `${options.adapterName} adapter: live stderr`
    );
  }

  return {
    state,
    consumeChunk(chunk: string): void {
      state.buffer += chunk;
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },
    flush(): void {
      if (!state.buffer) {
        return;
      }
      processLine(state.buffer);
      state.buffer = "";
    },
  };
}
