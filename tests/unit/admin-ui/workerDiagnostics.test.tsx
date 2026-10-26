/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCycles } from "../../../src/admin/ui/views/TasksView/AgentCycles.js";
import type { ApiCycle } from "../../../src/admin/ui/types.js";

const diagnostic = {
  exitCode: 0, stdout: '<script>alert("x")</script> partial JSON', stderr: "worker timed out",
  stdoutBytes: 90000, stderrBytes: 16, stdoutTruncated: true, stderrTruncated: false,
  redacted: true, parseError: "Unexpected end of JSON input",
};

function cycle(workerOutput: unknown = diagnostic): ApiCycle {
  return {
    id: 1, taskId: "review-42", cycleNumber: 1, createdAt: "2026-09-22T16:19:50Z",
    durationMs: 540000, cost: null, validationResult: null,
    result: { status: "failed", modifiedFiles: [], summary: "Agent worker returned invalid JSON",
      agentLogs: "", metadata: { workerOutput } },
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("worker diagnostics in agent cycles", () => {
  it("keeps an escaped model fallback warning visible after collapse and reload", () => {
    const fallback = cycle();
    fallback.result = {
      ...fallback.result, status: "success", metadata: {},
      agentEvents: [{
        type: "session.model_fallback", timestamp: "2026-10-26T18:00:00Z",
        taskId: fallback.taskId, cycleNumber: 1,
        data: { requestedModel: "<script>retired-model</script>", selectedModel: "auto" },
      }],
    };
    const persisted: ApiCycle = JSON.parse(JSON.stringify(fallback));
    const view = render(<AgentCycles cycles={[persisted]} />);
    fireEvent.click(screen.getByRole("button", { name: /Cycle 1/ }));
    expect(screen.getByRole("status").textContent).toContain("<script>retired-model</script>");
    expect(screen.getByRole("status").textContent).toContain("Update the configured model");
    expect(screen.getByText("success")).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    view.unmount();
    render(<AgentCycles cycles={[persisted]} />);
    expect(screen.getByRole("status").textContent).toContain("automatic model selection");
  });

  it("renders escaped output, byte counts, truncation and parser details", () => {
    const { container } = render(<AgentCycles cycles={[cycle()]} />);
    expect(screen.getByText("Worker diagnostics")).toBeTruthy();
    expect(screen.getByText(diagnostic.stdout)).toBeTruthy();
    expect(screen.getByText(diagnostic.stderr)).toBeTruthy();
    expect(screen.getByText(/90000 bytes.*truncated/)).toBeTruthy();
    expect(screen.getByText(diagnostic.parseError)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("copies the persisted diagnostic", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<AgentCycles cycles={[cycle()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy worker diagnostics", hidden: true }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(diagnostic, null, 2)));
  });

  it("downloads the diagnostic and releases the object URL", () => {
    const createObjectURL = vi.fn(() => "blob:diagnostic");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<AgentCycles cycles={[cycle()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download worker diagnostics", hidden: true }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe("worker-cycle-1-diagnostics.json");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagnostic");
  });

  it("ignores missing and malformed diagnostics in older cycles", () => {
    render(<AgentCycles cycles={[cycle(null)]} />);
    expect(screen.queryByText("Worker diagnostics")).toBeNull();
  });
});