import { vi } from "vitest";
import type {
  GitCommandResult,
  GitRunOptions,
  GitRunner,
} from "../../../src/vcs/gitRunner.js";

export interface RecordedGitCall {
  args: readonly string[];
  options: GitRunOptions;
}

export class RecordingGitRunner implements GitRunner {
  readonly calls: RecordedGitCall[] = [];
  readonly run = vi.fn(async (
    args: readonly string[],
    options: GitRunOptions
  ): Promise<GitCommandResult> => {
    this.calls.push({ args, options });
    return { stdout: "", stderr: "" };
  });

  findCall(...args: string[]): RecordedGitCall | undefined {
    return this.calls.find((call) =>
      call.args.length === args.length
      && call.args.every((arg, index) => arg === args[index])
    );
  }
}